import { createAuroraCluster } from './lib/aurora';
import { createAuthPool } from './lib/cognito';
import { createDatabaseMigrations } from './lib/databaseMigrations';
import { createIngestionApi } from './lib/ingestionApi';
import { createIngestionPipeline } from './lib/ingestionPipeline';
import { createMcpApi } from './lib/mcpApi';
import { createAwsProvider } from './lib/provider';

const provider = createAwsProvider();
const authPool = createAuthPool(provider);
const auroraCluster = createAuroraCluster(provider);
const dbConfig = auroraCluster.dbConfig;
const migrations = createDatabaseMigrations(
  provider,
  dbConfig,
  auroraCluster.instance,
);
// Schema before code: application Lambdas update only after migrations succeed.
const afterMigrations = [migrations.invocation];
const ingestionPipeline = createIngestionPipeline(
  provider,
  dbConfig,
  afterMigrations,
);
const ingestionApi = createIngestionApi(
  authPool.userPool,
  provider,
  dbConfig,
  ingestionPipeline.uploadsBucket,
  afterMigrations,
);
const mcpApi = createMcpApi(authPool.userPool, provider, afterMigrations);

export const userPoolId = authPool.userPool.id;
export const userPoolArn = authPool.userPool.arn;
export const userPoolClientId = authPool.userPoolClient.id;
export const authDomain = authPool.domain.domain;
export const ingestionApiId = ingestionApi.restApi.id;
export const ingestionInvokeUrl = ingestionApi.invokeUrl;
export const uploadsBucketName = ingestionPipeline.uploadsBucket.bucket;
export const ingestionQueueUrl = ingestionPipeline.queue.url;
export const ingestionDlqUrl = ingestionPipeline.deadLetterQueue.url;
export const rebuildAccountFunctionName = ingestionPipeline.rebuildFunction.name;
export const mcpApiId = mcpApi.restApi.id;
export const mcpInvokeUrl = mcpApi.invokeUrl;
