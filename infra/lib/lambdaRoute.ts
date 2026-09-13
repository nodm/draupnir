import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';

export const LAMBDA_ASSUME_ROLE_POLICY = JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: { Service: 'lambda.amazonaws.com' },
      Action: 'sts:AssumeRole',
    },
  ],
});

export const LAMBDA_BASIC_EXECUTION_POLICY_ARN =
  'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole';

export interface LambdaRouteConfig {
  name: string;
  pathPart: string;
  httpMethod: string;
  handler: string;
  // The Nx build output directory this route's Lambda bundle lives in, e.g.
  // '../dist/ingestion' or '../dist/mcp' — each app builds to its own
  // directory, so this can't be a shared default.
  codePath: string;
  environment?: Record<string, pulumi.Input<string>>;
  policyStatements?: pulumi.Input<Record<string, unknown>>[];
  timeoutSeconds?: number;
}

export interface LambdaRoute {
  resource: aws.apigateway.Resource;
  method: aws.apigateway.Method;
  integration: aws.apigateway.Integration;
}

// Shared shape for a new API Gateway route backed by its own Lambda function,
// used by every endpoint added after `whoami` (kept as its original
// hand-written block in ingestionApi.ts to avoid touching working,
// already-deployed code) and, via `codePath`, by other apps' REST APIs (see
// `mcpApi.ts`).
export function createLambdaRoute(
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
      timeout: config.timeoutSeconds,
      code: new pulumi.asset.FileArchive(config.codePath),
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
      timeoutMilliseconds: config.timeoutSeconds
        ? config.timeoutSeconds * 1000
        : undefined,
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
