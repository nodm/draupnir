import { RDSDataClient } from '@aws-sdk/client-rds-data';
import type { Context } from 'aws-lambda';
import {
  createDataApiExecutor,
  loadDataApiConfigFromEnv,
  MIGRATIONS,
  runMigrations,
  type RunMigrationsResult,
} from 'shared';

// Time left for rolling back once waiting for the migration lock is abandoned
// (design.md decision 2).
const ROLLBACK_RESERVE_MS = 60_000;

export const handler = async (
  _event: unknown,
  context: Pick<Context, 'getRemainingTimeInMillis'>,
): Promise<RunMigrationsResult> => {
  const executor = createDataApiExecutor(
    new RDSDataClient({}),
    loadDataApiConfigFromEnv(),
  );

  return runMigrations({
    executor,
    migrations: MIGRATIONS,
    lockDeadlineMs:
      Date.now() + context.getRemainingTimeInMillis() - ROLLBACK_RESERVE_MS,
    log: (message) => console.log(message),
  });
};
