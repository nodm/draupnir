import { RDSDataClient } from '@aws-sdk/client-rds-data';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
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

// The draupnir_app password lives only in Secrets Manager; the runner reads it
// here and binds it as a parameter (never in statement text or logs).
async function loadAppRolePassword(): Promise<string> {
  const secretId = process.env['APP_DB_SECRET_ARN'];
  if (!secretId) {
    throw new Error('Missing APP_DB_SECRET_ARN environment variable');
  }
  const response = await new SecretsManagerClient({}).send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );
  const { password } = JSON.parse(response.SecretString ?? '{}') as {
    password?: string;
  };
  if (!password) {
    throw new Error('App database secret has no password');
  }
  return password;
}

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
    appRolePassword: await loadAppRolePassword(),
    lockDeadlineMs:
      Date.now() + context.getRemainingTimeInMillis() - ROLLBACK_RESERVE_MS,
    log: (message) => console.log(message),
  });
};
