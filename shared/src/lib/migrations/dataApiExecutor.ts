import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import {
  beginTransaction,
  commitTransaction,
  executeStatement,
  rollbackTransaction,
  type DataApiConfig,
  type ResumeRetryOptions,
} from '../dataApi';
import type { MigrationExecutor } from './runMigrations';

// The migration runner has 300 seconds and may be the first thing to wake the
// cluster, so it waits longer than the default. The retry itself lives in
// dataApi.ts (one layer); this only widens its budget.
const MIGRATION_MAX_TOTAL_WAIT_MS = 120_000;

export function createDataApiExecutor(
  client: RDSDataClient,
  baseConfig: DataApiConfig,
  retryOptions?: ResumeRetryOptions,
): MigrationExecutor {
  const config: DataApiConfig = {
    ...baseConfig,
    resumeRetry: {
      maxTotalWaitMs: MIGRATION_MAX_TOTAL_WAIT_MS,
      ...baseConfig.resumeRetry,
      ...retryOptions,
    },
  };

  return {
    begin: () => beginTransaction(client, config),
    async execute(sql, transactionId, parameters = {}) {
      const result = await executeStatement(
        client,
        config,
        sql,
        parameters,
        transactionId,
      );
      return result.rows;
    },
    commit: (transactionId) => commitTransaction(client, config, transactionId),
    rollback: (transactionId) =>
      rollbackTransaction(client, config, transactionId),
  };
}
