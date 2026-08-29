import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';

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

export function createIngestionApi(
  userPool: aws.cognito.UserPool,
  provider: aws.Provider,
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

  const deployment = new aws.apigateway.Deployment(
    'ingestion',
    {
      restApi: restApi.id,
      // Hash the actual route configuration, not resource IDs — IDs stay
      // stable across an authorizer/integration config change, which would
      // silently leave the stage serving a stale snapshot otherwise.
      triggers: {
        redeployment: pulumi
          .all([
            whoamiResource.pathPart,
            whoamiMethod.httpMethod,
            whoamiMethod.authorization,
            whoamiMethod.authorizerId,
            whoamiIntegration.type,
            whoamiIntegration.integrationHttpMethod,
            whoamiIntegration.uri,
            authorizer.providerArns,
          ])
          .apply((values) => JSON.stringify(values)),
      },
    },
    { provider, dependsOn: [whoamiMethod, whoamiIntegration] },
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
