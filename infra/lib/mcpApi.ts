import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import { createLambdaRoute } from './lambdaRoute';

export interface McpApi {
  restApi: aws.apigateway.RestApi;
  invokeUrl: pulumi.Output<string>;
}

export function createMcpApi(
  userPool: aws.cognito.UserPool,
  provider: aws.Provider,
): McpApi {
  const withProvider = { provider };

  const restApi = new aws.apigateway.RestApi(
    'mcp',
    {
      name: 'draupnir-mcp',
      // See ingestionApi.ts's restApi comment — same regional rationale, and
      // MCP's own ADR-0001 leaves response streaming available at this same
      // REST-API level for later, unused by this base wiring.
      endpointConfiguration: { types: 'REGIONAL' },
    },
    withProvider,
  );

  // A separate authorizer resource from ingestion's — API Gateway scopes an
  // Authorizer to one REST API — but bound to the same Cognito user pool, so
  // one identity source authenticates both APIs (ADR-0001).
  const authorizer = new aws.apigateway.Authorizer(
    'mcp-cognito',
    {
      restApi: restApi.id,
      name: 'cognito',
      type: 'COGNITO_USER_POOLS',
      providerArns: [userPool.arn],
      identitySource: 'method.request.header.Authorization',
    },
    withProvider,
  );

  const mcpRoute = createLambdaRoute(
    {
      name: 'mcp',
      pathPart: 'mcp',
      httpMethod: 'POST',
      handler: 'handler.handler',
      codePath: '../dist/mcp',
    },
    restApi,
    authorizer,
    provider,
  );

  const deployment = new aws.apigateway.Deployment(
    'mcp',
    {
      restApi: restApi.id,
      // See ingestionApi.ts's deployment comment — hash route config, not
      // resource ids, so a config change actually redeploys the stage.
      triggers: {
        redeployment: pulumi.jsonStringify([
          mcpRoute.resource.pathPart,
          mcpRoute.method.httpMethod,
          mcpRoute.method.authorization,
          mcpRoute.method.authorizerId,
          mcpRoute.integration.type,
          mcpRoute.integration.integrationHttpMethod,
          mcpRoute.integration.uri,
          authorizer.providerArns,
        ]),
      },
    },
    {
      provider,
      dependsOn: [mcpRoute.method, mcpRoute.integration],
    },
  );

  const stage = new aws.apigateway.Stage(
    'mcp-stage',
    {
      restApi: restApi.id,
      deployment: deployment.id,
      stageName: pulumi.getStack(),
    },
    withProvider,
  );

  return { restApi, invokeUrl: stage.invokeUrl };
}
