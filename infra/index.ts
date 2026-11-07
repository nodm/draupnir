import { createAuroraCluster } from './lib/aurora';
import { createBot } from './lib/bot';
import { createBotQueues } from './lib/botQueues';
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
// Master credential: the migration runner only. Everything else uses the
// draupnir_app credential, which row-level security applies to.
const migrations = createDatabaseMigrations(
  provider,
  dbConfig,
  auroraCluster.instance,
  auroraCluster.appSecretVersion,
);
const appDbConfig = auroraCluster.appDbConfig;
// Schema before code: application Lambdas update only after migrations succeed.
const afterMigrations = [migrations.invocation];
// Created first: ingestion publishes each file's outcome to it.
const botQueues = createBotQueues(provider);
const ingestionPipeline = createIngestionPipeline(
  provider,
  appDbConfig,
  afterMigrations,
  botQueues.outcomes,
);
const ingestionApi = createIngestionApi(
  authPool.userPool,
  provider,
  appDbConfig,
  ingestionPipeline.uploadsBucket,
  afterMigrations,
);
const mcpApi = createMcpApi(authPool, provider, appDbConfig, afterMigrations);
const bot = createBot(provider, {
  authPool,
  dbConfig: appDbConfig,
  uploadsBucket: ingestionPipeline.uploadsBucket,
  queues: botQueues,
  dependsOn: afterMigrations,
});

export const userPoolId = authPool.userPool.id;
export const userPoolArn = authPool.userPool.arn;
export const userPoolClientId = authPool.userPoolClient.id;
export const authDomain = authPool.domain.domain;
export const ingestionApiId = ingestionApi.restApi.id;
export const ingestionInvokeUrl = ingestionApi.invokeUrl;
export const uploadsBucketName = ingestionPipeline.uploadsBucket.bucket;
export const ingestionQueueUrl = ingestionPipeline.queue.url;
export const ingestionDlqUrl = ingestionPipeline.deadLetterQueue.url;
export const rebuildAccountFunctionName =
  ingestionPipeline.rebuildFunction.name;
export const mcpApiId = mcpApi.restApi.id;
export const mcpInvokeUrl = mcpApi.invokeUrl;
export const mcpUrl = mcpApi.mcpUrl;
export const botWebhookUrl = bot.webhookUrl;
export const botCallbackUrl = bot.callbackUrl;
export const botTokenSecretArn = bot.botTokenSecret.arn;
export const botWebhookSecretArn = bot.webhookSecret.arn;
export const botUpdatesQueueUrl = botQueues.updates.url;
export const botUpdatesDlqUrl = botQueues.updatesDlq.url;
export const botOutcomesQueueUrl = botQueues.outcomes.url;
export const botOutcomesDlqUrl = botQueues.outcomesDlq.url;
