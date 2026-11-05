import {
  BatchExecuteStatementCommand,
  BeginTransactionCommand,
  CommitTransactionCommand,
  ExecuteStatementCommand,
  type Field,
  type RDSDataClient,
  RollbackTransactionCommand,
  type SqlParameter,
  type TypeHint,
} from '@aws-sdk/client-rds-data';

// Narrow repository interface over RDS Data API per ADR-0003 — callers never
// touch @aws-sdk/client-rds-data directly, so a future move to a driver-based
// client stays contained to this module.

export interface DataApiConfig {
  resourceArn: string;
  secretArn: string;
  database: string;
  // How long calls wait for a paused cluster to wake (see withResumeRetry).
  resumeRetry?: ResumeRetryOptions;
}

export interface ResumeRetryOptions {
  maxTotalWaitMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

// Fits the bot worker's 90-second timeout; the migration runner, which has 300
// seconds, asks for more.
const DEFAULT_MAX_TOTAL_WAIT_MS = 60_000;
const DEFAULT_INITIAL_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 15_000;

const isResumeInProgress = (error: unknown): boolean =>
  error instanceof Error && error.name === 'DatabaseResumingException';

// The cluster scales to zero (aurora.ts). The first Data API call after a pause
// is refused with DatabaseResumingException while it wakes, which takes seconds
// up to about a minute. The refusal comes before anything runs, so waiting and
// asking again is always safe. Without this, the first message after a quiet
// spell would fail and wait for its queue's next delivery instead. Only that
// error is retried, with capped exponential backoff. This is the one retry
// layer: every executeStatement, batchExecuteStatement and beginTransaction
// goes through it, so callers (and the migration runner) must not add another.
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

export function loadDataApiConfigFromEnv(): DataApiConfig {
  const resourceArn = process.env['DB_CLUSTER_ARN'];
  const secretArn = process.env['DB_SECRET_ARN'];
  const database = process.env['DB_NAME'];

  if (!resourceArn || !secretArn || !database) {
    throw new Error(
      'Missing DB_CLUSTER_ARN/DB_SECRET_ARN/DB_NAME environment variables',
    );
  }

  return { resourceArn, secretArn, database };
}

// BatchExecuteStatement — unlike ExecuteStatement — won't implicitly cast a
// stringValue to a non-text column type (observed against a live cluster:
// inserting posted_date this way fails with "column is of type date but
// expression is of type text"), so a DATE column's value needs an explicit
// typeHint alongside it.
export interface TypedSqlParameterValue {
  readonly typeHint: TypeHint;
  readonly value: string;
}

export function dateParameter(value: string): TypedSqlParameterValue {
  return { typeHint: 'DATE', value };
}

export type SqlParameterValue =
  | string
  | number
  | boolean
  | null
  | TypedSqlParameterValue;

export interface ExecuteResult {
  rows: Record<string, unknown>[];
  numberOfRecordsUpdated: number;
}

function isTypedSqlParameterValue(
  value: SqlParameterValue,
): value is TypedSqlParameterValue {
  return typeof value === 'object' && value !== null;
}

function toField(value: string | number | boolean | null): Field {
  if (value === null) {
    return { isNull: true };
  }
  if (typeof value === 'string') {
    return { stringValue: value };
  }
  if (typeof value === 'boolean') {
    return { booleanValue: value };
  }
  return { doubleValue: value };
}

function toSqlParameters(
  parameters: Record<string, SqlParameterValue>,
): SqlParameter[] {
  return Object.entries(parameters).map(([name, value]) => {
    if (isTypedSqlParameterValue(value)) {
      return {
        name,
        value: { stringValue: value.value },
        typeHint: value.typeHint,
      };
    }
    return { name, value: toField(value) };
  });
}

export async function executeStatement(
  client: RDSDataClient,
  config: DataApiConfig,
  sql: string,
  parameters: Record<string, SqlParameterValue> = {},
  transactionId?: string,
): Promise<ExecuteResult> {
  const response = await withResumeRetry(
    () =>
      client.send(
        new ExecuteStatementCommand({
          resourceArn: config.resourceArn,
          secretArn: config.secretArn,
          database: config.database,
          sql,
          parameters: toSqlParameters(parameters),
          transactionId,
          formatRecordsAs: 'JSON',
        }),
      ),
    config.resumeRetry,
  );

  return {
    rows: response.formattedRecords
      ? JSON.parse(response.formattedRecords)
      : [],
    numberOfRecordsUpdated: response.numberOfRecordsUpdated ?? 0,
  };
}

// Runs one SQL statement once per parameter set in a single Data API call —
// used for the ingestion write path so a multi-thousand-row statement file
// doesn't cost one network round trip per row (see statement-ingestion-
// pipeline spec). Data API caps a single call's request at 4 MiB; callers
// are responsible for chunking parameterSets to stay under that.
export async function batchExecuteStatement(
  client: RDSDataClient,
  config: DataApiConfig,
  sql: string,
  parameterSets: Record<string, SqlParameterValue>[],
  transactionId?: string,
): Promise<void> {
  await withResumeRetry(
    () =>
      client.send(
        new BatchExecuteStatementCommand({
          resourceArn: config.resourceArn,
          secretArn: config.secretArn,
          database: config.database,
          sql,
          parameterSets: parameterSets.map(toSqlParameters),
          transactionId,
        }),
      ),
    config.resumeRetry,
  );
}

export async function beginTransaction(
  client: RDSDataClient,
  config: DataApiConfig,
): Promise<string> {
  const response = await withResumeRetry(
    () =>
      client.send(
        new BeginTransactionCommand({
          resourceArn: config.resourceArn,
          secretArn: config.secretArn,
          database: config.database,
        }),
      ),
    config.resumeRetry,
  );

  if (!response.transactionId) {
    throw new Error('BeginTransaction did not return a transactionId');
  }
  return response.transactionId;
}

export async function commitTransaction(
  client: RDSDataClient,
  config: DataApiConfig,
  transactionId: string,
): Promise<void> {
  await client.send(
    new CommitTransactionCommand({
      resourceArn: config.resourceArn,
      secretArn: config.secretArn,
      transactionId,
    }),
  );
}

export async function rollbackTransaction(
  client: RDSDataClient,
  config: DataApiConfig,
  transactionId: string,
): Promise<void> {
  await client.send(
    new RollbackTransactionCommand({
      resourceArn: config.resourceArn,
      secretArn: config.secretArn,
      transactionId,
    }),
  );
}

// Runs `fn` in one Data API transaction scoped to `sub`. The identity is set
// with set_config(..., is_local = true), so it lasts only for this transaction
// and can't leak to the next request on a pooled session. Database access
// outside withCaller has no identity, so RLS returns nothing (fails closed).
export async function withCaller<T>(
  client: RDSDataClient,
  config: DataApiConfig,
  sub: string,
  fn: (transactionId: string) => Promise<T>,
): Promise<T> {
  if (!sub) {
    throw new Error('withCaller requires a non-empty sub');
  }
  const transactionId = await beginTransaction(client, config);
  try {
    await executeStatement(
      client,
      config,
      `SELECT set_config('app.sub', :sub, true)`,
      { sub },
      transactionId,
    );
    const result = await fn(transactionId);
    await commitTransaction(client, config, transactionId);
    return result;
  } catch (error) {
    try {
      await rollbackTransaction(client, config, transactionId);
    } catch {
      // surface the original error
    }
    throw error;
  }
}
