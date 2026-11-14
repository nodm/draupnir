import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import { createLambdaFunction } from './lambdaFunction';
import type { AuthPool } from './cognito';
import { dataApiPolicyStatements, type DbConfig } from './ingestionPipeline';
import {
  authorizationServerMetadata,
  protectedResourceMetadata,
} from './mcpOAuthMetadata';
import {
  createLambdaRoute,
  LAMBDA_ASSUME_ROLE_POLICY,
  LAMBDA_BASIC_EXECUTION_POLICY_ARN,
} from './lambdaRoute';

// API Gateway's REST integration timeout ceiling without a quota increase:
// covers an Aurora resume-from-pause plus withCaller's Data API calls.
const DB_BACKED_ROUTE_TIMEOUT_SECONDS = 29;

// The 128 MB default ran at 114-119 MB with Runtime.ExitError crashes of
// unknown cause on client connects; more headroom rules memory out.
const MCP_FUNCTION_MEMORY_MB = 256;

// Cost and capacity guardrail for every method without its own limit (`*/*`):
// about 3x a simultaneous reconnect of every client on POST /mcp, far below
// the account default. Applies per method, not to the stage as a whole. See
// openspec/changes/archive/2026-11-13-add-api-throttle-defaults/design.md (decisions 2-3).
const DEFAULT_THROTTLE = { rateLimit: 10, burstLimit: 20 };
// Stricter limits on single methods override the default for that method.
// A client calls the token endpoint once per sign-in or refresh.
const TOKEN_THROTTLE = { rateLimit: 5, burstLimit: 10 };
// Registration is rare; a low rate limits what an unauthenticated caller can
// create in the user pool.
const REGISTER_THROTTLE = { rateLimit: 1, burstLimit: 5 };
// The discovery documents are fetched once per client connect and /authorize
// once per sign-in, so 1 request per second with room for a reconnect or two
// is enough. Each method has its own bucket.
const RARE_ROUTE_THROTTLE = { rateLimit: 1, burstLimit: 5 };
const OAUTH_FUNCTION_TIMEOUT_SECONDS = 10;
// Cached by clients for five minutes; the documents change only on a deploy.
const DISCOVERY_CACHE_CONTROL = 'public, max-age=300';

export interface McpApi {
  restApi: aws.apigateway.RestApi;
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
      // Regional, not the default edge-optimized: no CloudFront benefit for a
      // Cognito-authenticated API with no global audience, and only Regional or
      // private REST APIs can request an integration timeout past 29s if the
      // Aurora resume latency (aurora.ts) ever needs it. ADR-0001 also leaves
      // response streaming available at this REST-API level for later.
      endpointConfiguration: { types: 'REGIONAL' },
      // Served only on the custom domain below; the execute-api URL answers
      // 403. Takes effect on the next deployment (see the trigger below).
      disableExecuteApiEndpoint: true,
    },
    withProvider,
  );

  // The stack's only Cognito authorizer: no other API accepts the user pool's
  // tokens, so a token issued to a registered MCP client opens nothing else
  // (guardrails.spec.ts; user-authentication spec).
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

  // Discovery and registration (mcp-oauth-discovery): unauthenticated. The
  // discovery documents are answered by API Gateway itself; authorize, token
  // and registration run one Lambda. The challenge header lets a client find
  // the metadata from a 401.
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
  const oauthFunction = createLambdaFunction(
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
  // The documents are fixed at deploy time and served by MOCK integrations, so
  // a discovery request never invokes a function (mcpOAuthMetadata.ts).
  const metadataConfig = userPool.id.apply((userPoolId) => ({
    origin: mcpOrigin,
    userPoolId,
    region,
  }));
  const protectedResourceDocument = metadataConfig.apply((c) =>
    JSON.stringify(protectedResourceMetadata(c)),
  );
  const authorizationServerDocument = metadataConfig.apply((c) =>
    JSON.stringify(authorizationServerMetadata(c)),
  );
  const oauthEndpoints: {
    key: string;
    resource: aws.apigateway.Resource;
    // The resource path without its leading slash, for the method settings.
    path: string;
    httpMethod: string;
    // Set for a discovery route: the JSON the MOCK integration answers with.
    document?: pulumi.Output<string>;
  }[] = [
    {
      key: 'protected-resource',
      resource: protectedResource,
      path: '.well-known/oauth-protected-resource',
      httpMethod: 'GET',
      document: protectedResourceDocument,
    },
    {
      key: 'protected-resource-mcp',
      resource: oauthResource(
        'mcp-protected-resource-mcp',
        protectedResource.id,
        'mcp',
      ),
      path: '.well-known/oauth-protected-resource/mcp',
      httpMethod: 'GET',
      document: protectedResourceDocument,
    },
    {
      key: 'authorization-server',
      resource: oauthResource(
        'mcp-authorization-server',
        wellKnown.id,
        'oauth-authorization-server',
      ),
      path: '.well-known/oauth-authorization-server',
      httpMethod: 'GET',
      document: authorizationServerDocument,
    },
    {
      key: 'openid-configuration',
      resource: oauthResource(
        'mcp-openid-configuration',
        wellKnown.id,
        'openid-configuration',
      ),
      path: '.well-known/openid-configuration',
      httpMethod: 'GET',
      document: authorizationServerDocument,
    },
    {
      key: 'register',
      resource: oauthResource(
        'mcp-register',
        restApi.rootResourceId,
        'register',
      ),
      path: 'register',
      httpMethod: 'POST',
    },
    {
      key: 'authorize',
      resource: oauthResource(
        'mcp-authorize',
        restApi.rootResourceId,
        'authorize',
      ),
      path: 'authorize',
      httpMethod: 'GET',
    },
    {
      key: 'token',
      resource: oauthResource('mcp-token', restApi.rootResourceId, 'token'),
      path: 'token',
      httpMethod: 'POST',
    },
  ];
  const oauthMethods = oauthEndpoints.map(
    ({ key, resource, httpMethod, document }) => {
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
      if (document === undefined) {
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
        return { resource, method, integration, responses: [] };
      }
      const integration = new aws.apigateway.Integration(
        `mcp-oauth-${key}`,
        {
          restApi: restApi.id,
          resourceId: resource.id,
          httpMethod: method.httpMethod,
          type: 'MOCK',
          requestTemplates: { 'application/json': '{"statusCode": 200}' },
        },
        withProvider,
      );
      const methodResponse = new aws.apigateway.MethodResponse(
        `mcp-oauth-${key}`,
        {
          restApi: restApi.id,
          resourceId: resource.id,
          httpMethod: method.httpMethod,
          statusCode: '200',
          responseParameters: {
            'method.response.header.Content-Type': true,
            'method.response.header.Cache-Control': true,
          },
        },
        { provider, dependsOn: [method] },
      );
      const integrationResponse = new aws.apigateway.IntegrationResponse(
        `mcp-oauth-${key}`,
        {
          restApi: restApi.id,
          resourceId: resource.id,
          httpMethod: method.httpMethod,
          statusCode: '200',
          responseTemplates: { 'application/json': document },
          responseParameters: {
            'method.response.header.Content-Type': "'application/json'",
            'method.response.header.Cache-Control': `'${DISCOVERY_CACHE_CONTROL}'`,
          },
        },
        { provider, dependsOn: [integration, methodResponse] },
      );
      return {
        resource,
        method,
        integration,
        responses: [methodResponse, integrationResponse],
      };
    },
  );

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
      // Hash the route configuration, not resource ids: ids stay the same
      // across an authorizer or integration change, which would otherwise
      // leave the stage serving a stale snapshot.
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
            m.integration.type,
            m.integration.uri,
            m.integration.requestTemplates,
            m.responses.map((r) => [
              r.responseParameters,
              'responseTemplates' in r ? r.responseTemplates : undefined,
            ]),
          ]),
          unauthorized.responseParameters,
          // API Gateway applies a changed endpoint setting only on redeploy.
          restApi.disableExecuteApiEndpoint,
        ]),
      },
    },
    {
      provider,
      dependsOn: [
        mcpRoute.method,
        mcpRoute.integration,
        unauthorized,
        ...oauthMethods.flatMap((m) => [
          m.method,
          m.integration,
          ...m.responses,
        ]),
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
    'mcp-default-throttle',
    {
      restApi: restApi.id,
      stageName: stage.stageName,
      methodPath: '*/*',
      settings: {
        throttlingRateLimit: DEFAULT_THROTTLE.rateLimit,
        throttlingBurstLimit: DEFAULT_THROTTLE.burstLimit,
      },
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
        throttlingRateLimit: TOKEN_THROTTLE.rateLimit,
        throttlingBurstLimit: TOKEN_THROTTLE.burstLimit,
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
        throttlingRateLimit: REGISTER_THROTTLE.rateLimit,
        throttlingBurstLimit: REGISTER_THROTTLE.burstLimit,
      },
    },
    withProvider,
  );

  // The discovery documents and /authorize are rarely called; the Lambda
  // behind /authorize and the request count on the others stay small even
  // under an anonymous flood. Method paths are the resource path without its
  // leading slash, then the HTTP method.
  for (const { key, path, httpMethod } of oauthEndpoints) {
    if (key === 'token' || key === 'register') {
      continue;
    }
    new aws.apigateway.MethodSettings(
      `mcp-${key}-throttle`,
      {
        restApi: restApi.id,
        stageName: stage.stageName,
        methodPath: `${path}/${httpMethod}`,
        settings: {
          throttlingRateLimit: RARE_ROUTE_THROTTLE.rateLimit,
          throttlingBurstLimit: RARE_ROUTE_THROTTLE.burstLimit,
        },
      },
      withProvider,
    );
  }

  // Custom domain: the MCP URL and the OAuth well-known paths live at the
  // origin root, where clients probe. It is the API's only address: the
  // default execute-api endpoint is disabled on the RestApi above.
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
    mcpUrl: pulumi.output(`${mcpOrigin}/mcp`),
  };
}
