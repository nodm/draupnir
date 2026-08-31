import { createAuroraCluster } from './lib/aurora';
import { createAuthPool } from './lib/cognito';
import { createIngestionApi } from './lib/ingestionApi';
import { createIngestionPipeline } from './lib/ingestionPipeline';
import { createAwsProvider } from './lib/provider';

const provider = createAwsProvider();
const authPool = createAuthPool(provider);
const auroraCluster = createAuroraCluster(provider);
const dbConfig = auroraCluster.dbConfig;
const ingestionPipeline = createIngestionPipeline(provider, dbConfig);
const ingestionApi = createIngestionApi(
  authPool.userPool,
  provider,
  dbConfig,
  ingestionPipeline.uploadsBucket,
);

export const userPoolId = authPool.userPool.id;
export const userPoolArn = authPool.userPool.arn;
export const userPoolClientId = authPool.userPoolClient.id;
export const authDomain = authPool.domain.domain;
export const ingestionApiId = ingestionApi.restApi.id;
export const ingestionInvokeUrl = ingestionApi.invokeUrl;
export const uploadsBucketName = ingestionPipeline.uploadsBucket.bucket;
export const ingestionQueueUrl = ingestionPipeline.queue.url;
export const ingestionDlqUrl = ingestionPipeline.deadLetterQueue.url;
