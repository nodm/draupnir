import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import type { AuthPool } from './cognito';
import { dataApiPolicyStatements, type DbConfig } from './ingestionPipeline';
import {
  createLambdaRoute,
  LAMBDA_ASSUME_ROLE_POLICY,
  LAMBDA_BASIC_EXECUTION_POLICY_ARN,
} from './lambdaRoute';

// API Gateway's REST integration timeout ceiling, as for ingestion's DB-backed
// routes: covers an Aurora resume-from-pause plus withCaller's Data API calls.
const DB_BACKED_ROUTE_TIMEOUT_SECONDS = 29;

// The 128 MB default ran at 114-119 MB with Runtime.ExitError crashes of
// unknown cause on client connects; more headroom rules memory out.
const MCP_FUNCTION_MEMORY_MB = 256;

// Registration is rare; a low rate limits what an unauthenticated caller can
// create in the user pool.
const REGISTER_RATE_LIMIT = 1;
const REGISTER_BURST_LIMIT = 5;
const OAUTH_FUNCTION_TIMEOUT_SECONDS = 10;

export interface McpApi {
  restApi: aws.apigateway.RestApi;
  invokeUrl: pulumi.Output<string>;
  // The MCP endpoint on the custom domain, e.g. https://mcp.example/mcp.
  mcpUrl: pulumi.Output<string>;
}

export function createMcpApi(
  authPool: AuthPool,
  provider: aws.Provider,
  // The draupnir_app credential: row-level security applies to the tools.
  dbConfig: DbConfig,
  dependsOn: pulumi.Resource[] = [],
): McpApi {
  const withProvider = { provider };
  const userPool = authPool.userPool;
  const config = new pulumi.Config();
  const mcpHost = config.require('mcpHost');
  const mcpHostedZone = config.require('mcpHostedZone');
  const region = new pulumi.Config('aws').require('region');
  const mcpOrigin = `https://${mcpHost}`;

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
      timeoutSeconds: DB_BACKED_ROUTE_TIMEOUT_SECONDS,
      memorySizeMb: MCP_FUNCTION_MEMORY_MB,
      // MCP clients send the access token; the `openid` scope is on every one
      // issued through the app clients.
      authorizationScopes: ['openid'],
      environment: {
        DB_CLUSTER_ARN: dbConfig.clusterArn,
        DB_SECRET_ARN: dbConfig.secretArn,
        DB_NAME: dbConfig.name,
      },
      // Read-only tools: no BatchExecuteStatement.
      policyStatements: dataApiPolicyStatements(dbConfig, { batch: false }),
      dependsOn,
    },
    restApi,
    authorizer,
    provider,
  );

  // Discovery and registration (mcp-oauth-discovery): unauthenticated, one
  // Lambda. The challenge header lets a client find the metadata from a 401.
  const oauthRole = new aws.iam.Role(
    'mcp-oauth',
    { assumeRolePolicy: LAMBDA_ASSUME_ROLE_POLICY },
    withProvider,
  );
  new aws.iam.RolePolicyAttachment(
    'mcp-oauth-logs',
    { role: oauthRole.name, policyArn: LAMBDA_BASIC_EXECUTION_POLICY_ARN },
    withProvider,
  );
  // The only way the shim can change the user pool: create, brand and (on a
  // failed create) delete the clients it registers.
  new aws.iam.RolePolicy(
    'mcp-oauth-policy',
    {
      role: oauthRole.id,
      policy: pulumi.jsonStringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: [
              'cognito-idp:CreateUserPoolClient',
              'cognito-idp:ListUserPoolClients',
              'cognito-idp:CreateManagedLoginBranding',
              'cognito-idp:DeleteUserPoolClient',
            ],
            Resource: userPool.arn,
          },
        ],
      }),
    },
    withProvider,
  );
  const oauthFunction = new aws.lambda.Function(
    'mcp-oauth',
    {
      role: oauthRole.arn,
      runtime: aws.lambda.Runtime.NodeJS24dX,
      handler: 'oauth.handler',
      timeout: OAUTH_FUNCTION_TIMEOUT_SECONDS,
      code: new pulumi.asset.FileArchive('../dist/mcp'),
      environment: {
        variables: {
          MCP_ORIGIN: mcpOrigin,
          COGNITO_DOMAIN_URL: pulumi.interpolate`https://${authPool.domain.domain}.auth.${region}.amazoncognito.com`,
          USER_POOL_ID: userPool.id,
        },
      },
    },
    withProvider,
  );
  new aws.lambda.Permission(
    'mcp-oauth-invoke',
    {
      action: 'lambda:InvokeFunction',
      function: oauthFunction.name,
      principal: 'apigateway.amazonaws.com',
      sourceArn: pulumi.interpolate`${restApi.executionArn}/*/*`,
    },
    withProvider,
  );

  const oauthResource = (
    name: string,
    parentId: pulumi.Input<string>,
    pathPart: string,
  ) =>
    new aws.apigateway.Resource(
      name,
      { restApi: restApi.id, parentId, pathPart },
      withProvider,
    );
  const wellKnown = oauthResource(
    'mcp-well-known',
    restApi.rootResourceId,
    '.well-known',
  );
  const protectedResource = oauthResource(
    'mcp-protected-resource',
    wellKnown.id,
    'oauth-protected-resource',
  );
  const oauthEndpoints: {
    key: string;
    resource: aws.apigateway.Resource;
    httpMethod: string;
  }[] = [
    {
      key: 'protected-resource',
      resource: protectedResource,
      httpMethod: 'GET',
    },
    {
      key: 'protected-resource-mcp',
      resource: oauthResource(
        'mcp-protected-resource-mcp',
        protectedResource.id,
        'mcp',
      ),
      httpMethod: 'GET',
    },
    {
      key: 'authorization-server',
      resource: oauthResource(
        'mcp-authorization-server',
        wellKnown.id,
        'oauth-authorization-server',
      ),
      httpMethod: 'GET',
    },
    {
      key: 'openid-configuration',
      resource: oauthResource(
        'mcp-openid-configuration',
        wellKnown.id,
        'openid-configuration',
      ),
      httpMethod: 'GET',
    },
    {
      key: 'register',
      resource: oauthResource(
        'mcp-register',
        restApi.rootResourceId,
        'register',
      ),
      httpMethod: 'POST',
    },
    {
      key: 'authorize',
      resource: oauthResource(
        'mcp-authorize',
        restApi.rootResourceId,
        'authorize',
      ),
      httpMethod: 'GET',
    },
    {
      key: 'token',
      resource: oauthResource('mcp-token', restApi.rootResourceId, 'token'),
      httpMethod: 'POST',
    },
  ];
  const oauthMethods = oauthEndpoints.map(({ key, resource, httpMethod }) => {
    const method = new aws.apigateway.Method(
      `mcp-oauth-${key}`,
      {
        restApi: restApi.id,
        resourceId: resource.id,
        httpMethod,
        authorization: 'NONE',
      },
      withProvider,
    );
    const integration = new aws.apigateway.Integration(
      `mcp-oauth-${key}`,
      {
        restApi: restApi.id,
        resourceId: resource.id,
        httpMethod: method.httpMethod,
        integrationHttpMethod: 'POST',
        type: 'AWS_PROXY',
        uri: oauthFunction.invokeArn,
      },
      withProvider,
    );
    return { resource, method, integration };
  });

  const unauthorized = new aws.apigateway.Response(
    'mcp-unauthorized',
    {
      restApiId: restApi.id,
      responseType: 'UNAUTHORIZED',
      statusCode: '401',
      responseParameters: {
        'gatewayresponse.header.WWW-Authenticate': `'Bearer resource_metadata="${mcpOrigin}/.well-known/oauth-protected-resource/mcp"'`,
      },
      responseTemplates: {
        'application/json': '{"message":$context.error.messageString}',
      },
    },
    withProvider,
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
          mcpRoute.integration.timeoutMilliseconds,
          authorizer.providerArns,
          mcpRoute.method.authorizationScopes,
          oauthFunction.invokeArn,
          oauthMethods.map((m) => [
            m.resource.pathPart,
            m.method.httpMethod,
            m.integration.uri,
          ]),
          unauthorized.responseParameters,
        ]),
      },
    },
    {
      provider,
      dependsOn: [
        mcpRoute.method,
        mcpRoute.integration,
        unauthorized,
        ...oauthMethods.flatMap((m) => [m.method, m.integration]),
      ],
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

  new aws.apigateway.MethodSettings(
    'mcp-token-throttle',
    {
      restApi: restApi.id,
      stageName: stage.stageName,
      methodPath: 'token/POST',
      settings: {
        throttlingRateLimit: 5,
        throttlingBurstLimit: 10,
      },
    },
    withProvider,
  );

  new aws.apigateway.MethodSettings(
    'mcp-register-throttle',
    {
      restApi: restApi.id,
      stageName: stage.stageName,
      methodPath: 'register/POST',
      settings: {
        throttlingRateLimit: REGISTER_RATE_LIMIT,
        throttlingBurstLimit: REGISTER_BURST_LIMIT,
      },
    },
    withProvider,
  );

  // Custom domain: the MCP URL and the OAuth well-known paths live at the
  // origin root, where clients probe. The execute-api URL keeps working.
  const zone = aws.route53.getZoneOutput(
    { name: mcpHostedZone, privateZone: false },
    { provider },
  );
  const certificate = new aws.acm.Certificate(
    'mcp',
    { domainName: mcpHost, validationMethod: 'DNS' },
    withProvider,
  );
  const validationOption = certificate.domainValidationOptions[0];
  const validationRecord = new aws.route53.Record(
    'mcp-cert-validation',
    {
      zoneId: zone.zoneId,
      name: validationOption.resourceRecordName,
      type: validationOption.resourceRecordType,
      records: [validationOption.resourceRecordValue],
      ttl: 60,
    },
    withProvider,
  );
  const validatedCertificate = new aws.acm.CertificateValidation(
    'mcp',
    {
      certificateArn: certificate.arn,
      validationRecordFqdns: [validationRecord.fqdn],
    },
    withProvider,
  );
  const domainName = new aws.apigateway.DomainName(
    'mcp',
    {
      domainName: mcpHost,
      regionalCertificateArn: validatedCertificate.certificateArn,
      endpointConfiguration: { types: 'REGIONAL' },
      securityPolicy: 'TLS_1_2',
    },
    withProvider,
  );
  new aws.apigateway.BasePathMapping(
    'mcp',
    {
      domainName: domainName.domainName,
      restApi: restApi.id,
      stageName: stage.stageName,
    },
    withProvider,
  );
  new aws.route53.Record(
    'mcp-alias',
    {
      zoneId: zone.zoneId,
      name: mcpHost,
      type: 'A',
      aliases: [
        {
          name: domainName.regionalDomainName,
          zoneId: domainName.regionalZoneId,
          evaluateTargetHealth: false,
        },
      ],
    },
    withProvider,
  );

  return {
    restApi,
    invokeUrl: stage.invokeUrl,
    mcpUrl: pulumi.output(`${mcpOrigin}/mcp`),
  };
}
