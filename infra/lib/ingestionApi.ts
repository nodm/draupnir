import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import { dataApiPolicyStatements, type DbConfig } from './ingestionPipeline';

const LAMBDA_ASSUME_ROLE_POLICY = JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: { Service: 'lambda.amazonaws.com' },
      Action: 'sts:AssumeRole',
    },
  ],
});

const LAMBDA_BASIC_EXECUTION_POLICY_ARN =
  'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole';

export interface IngestionApi {
  restApi: aws.apigateway.RestApi;
  invokeUrl: pulumi.Output<string>;
}

interface LambdaRouteConfig {
  name: string;
  pathPart: string;
  httpMethod: string;
  handler: string;
  environment?: Record<string, pulumi.Input<string>>;
  policyStatements?: pulumi.Input<Record<string, unknown>>[];
}

interface LambdaRoute {
  resource: aws.apigateway.Resource;
  method: aws.apigateway.Method;
  integration: aws.apigateway.Integration;
}

// Shared shape for a new API Gateway route backed by its own Lambda function,
// used by every endpoint added after `whoami` (kept as its original
// hand-written block above to avoid touching working, already-deployed code).
function createLambdaRoute(
  config: LambdaRouteConfig,
  restApi: aws.apigateway.RestApi,
  authorizer: aws.apigateway.Authorizer,
  provider: aws.Provider,
): LambdaRoute {
  const withProvider = { provider };

  const role = new aws.iam.Role(
    config.name,
    { assumeRolePolicy: LAMBDA_ASSUME_ROLE_POLICY },
    withProvider,
  );

  new aws.iam.RolePolicyAttachment(
    `${config.name}-logs`,
    { role: role.name, policyArn: LAMBDA_BASIC_EXECUTION_POLICY_ARN },
    withProvider,
  );

  if (config.policyStatements && config.policyStatements.length > 0) {
    new aws.iam.RolePolicy(
      `${config.name}-policy`,
      {
        role: role.id,
        policy: pulumi.jsonStringify({
          Version: '2012-10-17',
          Statement: config.policyStatements,
        }),
      },
      withProvider,
    );
  }

  const lambdaFunction = new aws.lambda.Function(
    config.name,
    {
      role: role.arn,
      runtime: aws.lambda.Runtime.NodeJS24dX,
      handler: config.handler,
      code: new pulumi.asset.FileArchive('../dist/ingestion'),
      environment: config.environment
        ? { variables: config.environment }
        : undefined,
    },
    withProvider,
  );

  const resource = new aws.apigateway.Resource(
    config.name,
    {
      restApi: restApi.id,
      parentId: restApi.rootResourceId,
      pathPart: config.pathPart,
    },
    withProvider,
  );

  const method = new aws.apigateway.Method(
    `${config.name}-${config.httpMethod.toLowerCase()}`,
    {
      restApi: restApi.id,
      resourceId: resource.id,
      httpMethod: config.httpMethod,
      authorization: 'COGNITO_USER_POOLS',
      authorizerId: authorizer.id,
    },
    withProvider,
  );

  const integration = new aws.apigateway.Integration(
    `${config.name}-${config.httpMethod.toLowerCase()}`,
    {
      restApi: restApi.id,
      resourceId: resource.id,
      httpMethod: method.httpMethod,
      integrationHttpMethod: 'POST',
      type: 'AWS_PROXY',
      uri: lambdaFunction.invokeArn,
    },
    withProvider,
  );

  new aws.lambda.Permission(
    `${config.name}-invoke`,
    {
      action: 'lambda:InvokeFunction',
      function: lambdaFunction.name,
      principal: 'apigateway.amazonaws.com',
      sourceArn: pulumi.interpolate`${restApi.executionArn}/*/*`,
    },
    withProvider,
  );

  return { resource, method, integration };
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
      environment: {
        DB_CLUSTER_ARN: dbConfig.clusterArn,
        DB_SECRET_ARN: dbConfig.secretArn,
        DB_NAME: dbConfig.name,
      },
      policyStatements: dataApiPolicyStatements(dbConfig),
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
          presignedUploadRoute.resource.pathPart,
          presignedUploadRoute.method.httpMethod,
          presignedUploadRoute.method.authorization,
          presignedUploadRoute.method.authorizerId,
          presignedUploadRoute.integration.type,
          presignedUploadRoute.integration.integrationHttpMethod,
          presignedUploadRoute.integration.uri,
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
