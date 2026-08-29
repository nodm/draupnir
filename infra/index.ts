import { createAuthPool } from './lib/cognito';
import { createIngestionApi } from './lib/ingestionApi';
import { createAwsProvider } from './lib/provider';

const provider = createAwsProvider();
const authPool = createAuthPool(provider);
const ingestionApi = createIngestionApi(authPool.userPool, provider);

export const userPoolId = authPool.userPool.id;
export const userPoolArn = authPool.userPool.arn;
export const userPoolClientId = authPool.userPoolClient.id;
export const authDomain = authPool.domain.domain;
export const ingestionApiId = ingestionApi.restApi.id;
export const ingestionInvokeUrl = ingestionApi.invokeUrl;
