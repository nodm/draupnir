import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import {
  beginTransaction,
  commitTransaction,
  executeStatement,
  rollbackTransaction,
  type DataApiConfig,
} from '../dataApi';
import type { MigrationExecutor } from './runMigrations';

export interface ResumeRetryOptions {
  maxTotalWaitMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_TOTAL_WAIT_MS = 120_000;
const DEFAULT_INITIAL_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 15_000;

function isResumeInProgress(error: unknown): boolean {
  return error instanceof Error && error.name === 'DatabaseResumingException';
}

// An auto-paused cluster answers the first call with DatabaseResumingException
// until it is up. Retry only that error, with capped exponential backoff.
export async function withResumeRetry<T>(
  call: () => Promise<T>,
  options: ResumeRetryOptions = {},
): Promise<T> {
  const maxTotal = options.maxTotalWaitMs ?? DEFAULT_MAX_TOTAL_WAIT_MS;
  const maxDelay = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep =
    options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  let delay = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  let waited = 0;

  for (;;) {
    try {
      return await call();
    } catch (error) {
      if (!isResumeInProgress(error) || waited >= maxTotal) {
        throw error;
      }
      const wait = Math.min(delay, maxDelay, maxTotal - waited);
      await sleep(wait);
      waited += wait;
      delay *= 2;
    }
  }
}

export function createDataApiExecutor(
  client: RDSDataClient,
  config: DataApiConfig,
  retryOptions?: ResumeRetryOptions,
): MigrationExecutor {
  // Wrapping send() adds the retry to every Data API call without touching
  // dataApi.ts.
  // Bound once so the SDK's send() keeps its client receiver.
  const send = client.send.bind(client) as (c: unknown) => Promise<unknown>;
  const retryingClient = {
    send: (command: unknown) =>
      withResumeRetry(() => send(command), retryOptions),
  } as unknown as RDSDataClient;

  return {
    begin: () => beginTransaction(retryingClient, config),
    async execute(sql, transactionId, parameters = {}) {
      const result = await executeStatement(
        retryingClient,
        config,
        sql,
        parameters,
        transactionId,
      );
      return result.rows;
    },
    commit: (transactionId) =>
      commitTransaction(retryingClient, config, transactionId),
    rollback: (transactionId) =>
      rollbackTransaction(retryingClient, config, transactionId),
  };
}
