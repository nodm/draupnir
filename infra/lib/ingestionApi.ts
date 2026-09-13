import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import { dataApiPolicyStatements, type DbConfig } from './ingestionPipeline';
import {
  createLambdaRoute,
  LAMBDA_ASSUME_ROLE_POLICY,
  LAMBDA_BASIC_EXECUTION_POLICY_ARN,
} from './lambdaRoute';

// The Aurora cluster scales to zero when idle (see aurora.ts), and resuming
// from a pause can take several seconds up to ~1 minute. 29s is the ceiling
// API Gateway's REST API integration timeout allows without requesting an
// AWS Service Quota increase, so it's the most this route can wait without
// separate account-level setup — a rare worst-case resume can still exceed
// it and return a 504; callers should retry a failed request from a
// DB-backed route once before surfacing an error.
const DB_BACKED_ROUTE_TIMEOUT_SECONDS = 29;

export interface IngestionApi {
  restApi: aws.apigateway.RestApi;
  invokeUrl: pulumi.Output<string>;
}

export function createIngestionApi(
  userPool: aws.cognito.UserPool,
  provider: aws.Provider,
  dbConfig: DbConfig,
  uploadsBucket: aws.s3.Bucket,
): IngestionApi {
  const withProvider = { provider };

  const restApi = new aws.apigateway.RestApi(
    'ingestion',
    {
      name: 'draupnir-ingestion',
      // Regional, not the default edge-optimized: no CloudFront benefit for
      // a Cognito-authenticated API with no public/global traffic, and only
      // Regional/private REST APIs are eligible to request an
      // integration timeout increase past 29s if the Aurora resume-latency
      // risk (aurora.ts) ever needs that.
      endpointConfiguration: { types: 'REGIONAL' },
    },
    withProvider,
  );

  const authorizer = new aws.apigateway.Authorizer(
    'ingestion-cognito',
    {
      restApi: restApi.id,
      name: 'cognito',
      type: 'COGNITO_USER_POOLS',
      providerArns: [userPool.arn],
      identitySource: 'method.request.header.Authorization',
    },
    withProvider,
  );

  const whoamiRole = new aws.iam.Role(
    'whoami',
    {
      assumeRolePolicy: LAMBDA_ASSUME_ROLE_POLICY,
    },
    withProvider,
  );

  new aws.iam.RolePolicyAttachment(
    'whoami-logs',
    {
      role: whoamiRole.name,
      policyArn: LAMBDA_BASIC_EXECUTION_POLICY_ARN,
    },
    withProvider,
  );

  const whoamiFunction = new aws.lambda.Function(
    'whoami',
    {
      role: whoamiRole.arn,
      runtime: aws.lambda.Runtime.NodeJS24dX,
      handler: 'whoami.handler',
      code: new pulumi.asset.FileArchive('../dist/ingestion'),
    },
    withProvider,
  );

  const whoamiResource = new aws.apigateway.Resource(
    'whoami',
    {
      restApi: restApi.id,
      parentId: restApi.rootResourceId,
      pathPart: 'whoami',
    },
    withProvider,
  );

  const whoamiMethod = new aws.apigateway.Method(
    'whoami-get',
    {
      restApi: restApi.id,
      resourceId: whoamiResource.id,
      httpMethod: 'GET',
      authorization: 'COGNITO_USER_POOLS',
      authorizerId: authorizer.id,
    },
    withProvider,
  );

  const whoamiIntegration = new aws.apigateway.Integration(
    'whoami-get',
    {
      restApi: restApi.id,
      resourceId: whoamiResource.id,
      httpMethod: whoamiMethod.httpMethod,
      integrationHttpMethod: 'POST',
      type: 'AWS_PROXY',
      uri: whoamiFunction.invokeArn,
    },
    withProvider,
  );

  new aws.lambda.Permission(
    'whoami-invoke',
    {
      action: 'lambda:InvokeFunction',
      function: whoamiFunction.name,
      principal: 'apigateway.amazonaws.com',
      sourceArn: pulumi.interpolate`${restApi.executionArn}/*/*`,
    },
    withProvider,
  );

  const accountsRoute = createLambdaRoute(
    {
      name: 'accounts',
      pathPart: 'accounts',
      httpMethod: 'POST',
      handler: 'accounts.handler',
      codePath: '../dist/ingestion',
      environment: {
        DB_CLUSTER_ARN: dbConfig.clusterArn,
        DB_SECRET_ARN: dbConfig.secretArn,
        DB_NAME: dbConfig.name,
      },
      policyStatements: dataApiPolicyStatements(dbConfig),
      timeoutSeconds: DB_BACKED_ROUTE_TIMEOUT_SECONDS,
    },
    restApi,
    authorizer,
    provider,
  );

  const presignedUploadRoute = createLambdaRoute(
    {
      name: 'presigned-upload',
      pathPart: 'uploads',
      httpMethod: 'POST',
      handler: 'presignedUpload.handler',
      codePath: '../dist/ingestion',
      environment: {
        DB_CLUSTER_ARN: dbConfig.clusterArn,
        DB_SECRET_ARN: dbConfig.secretArn,
        DB_NAME: dbConfig.name,
        UPLOADS_BUCKET: uploadsBucket.bucket,
      },
      policyStatements: [
        ...dataApiPolicyStatements(dbConfig),
        {
          Effect: 'Allow',
          Action: 's3:PutObject',
          Resource: pulumi.interpolate`${uploadsBucket.arn}/*`,
        },
      ],
      timeoutSeconds: DB_BACKED_ROUTE_TIMEOUT_SECONDS,
    },
    restApi,
    authorizer,
    provider,
  );

  const deployment = new aws.apigateway.Deployment(
    'ingestion',
    {
      restApi: restApi.id,
      // Hash the actual route configuration, not resource IDs — IDs stay
      // stable across an authorizer/integration config change, which would
      // silently leave the stage serving a stale snapshot otherwise.
      triggers: {
        redeployment: pulumi.jsonStringify([
          whoamiResource.pathPart,
          whoamiMethod.httpMethod,
          whoamiMethod.authorization,
          whoamiMethod.authorizerId,
          whoamiIntegration.type,
          whoamiIntegration.integrationHttpMethod,
          whoamiIntegration.uri,
          accountsRoute.resource.pathPart,
          accountsRoute.method.httpMethod,
          accountsRoute.method.authorization,
          accountsRoute.method.authorizerId,
          accountsRoute.integration.type,
          accountsRoute.integration.integrationHttpMethod,
          accountsRoute.integration.uri,
          accountsRoute.integration.timeoutMilliseconds,
          presignedUploadRoute.resource.pathPart,
          presignedUploadRoute.method.httpMethod,
          presignedUploadRoute.method.authorization,
          presignedUploadRoute.method.authorizerId,
          presignedUploadRoute.integration.type,
          presignedUploadRoute.integration.integrationHttpMethod,
          presignedUploadRoute.integration.uri,
          presignedUploadRoute.integration.timeoutMilliseconds,
          authorizer.providerArns,
        ]),
      },
    },
    {
      provider,
      dependsOn: [
        whoamiMethod,
        whoamiIntegration,
        accountsRoute.method,
        accountsRoute.integration,
        presignedUploadRoute.method,
        presignedUploadRoute.integration,
      ],
    },
  );

  const stage = new aws.apigateway.Stage(
    'stage',
    {
      restApi: restApi.id,
      deployment: deployment.id,
      stageName: pulumi.getStack(),
    },
    withProvider,
  );

  return { restApi, invokeUrl: stage.invokeUrl };
}
