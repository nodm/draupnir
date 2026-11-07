import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Handler,
} from 'aws-lambda';
import {
  authorizationServerMetadata,
  authorizeRedirect,
  forwardToken,
  protectedResourceMetadata,
  registerClient,
  type CognitoLike,
  type FetchLike,
  type OAuthConfig,
} from './lib/oauth';

function loadConfig(): OAuthConfig {
  const origin = process.env['MCP_ORIGIN'];
  const cognitoDomainUrl = process.env['COGNITO_DOMAIN_URL'];
  const userPoolId = process.env['USER_POOL_ID'];
  const region = process.env['AWS_REGION'];
  if (!origin || !cognitoDomainUrl || !userPoolId || !region) {
    throw new Error(
      'Missing MCP_ORIGIN/COGNITO_DOMAIN_URL/USER_POOL_ID/AWS_REGION environment variables',
    );
  }
  return { origin, cognitoDomainUrl, userPoolId, region };
}

let cachedCognito: CognitoLike | undefined;
function defaultCognito(): CognitoLike {
  cachedCognito ??= new CognitoIdentityProviderClient({});
  return cachedCognito;
}

function json(
  statusCode: number,
  body: unknown,
  extra: Record<string, string> = {},
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', ...extra },
    body: JSON.stringify(body),
  };
}

const METADATA_CACHE = { 'cache-control': 'public, max-age=300' };

function parseBody(event: APIGatewayProxyEvent): unknown {
  if (!event.body) {
    return undefined;
  }
  const text = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  return JSON.parse(text);
}

export function createOAuthHandler(deps: {
  config: () => OAuthConfig;
  cognito: () => CognitoLike;
  fetch?: FetchLike;
}): Handler<APIGatewayProxyEvent, APIGatewayProxyResult> {
  return async (event) => {
    // `resource` is the API Gateway route template, independent of the stage
    // or custom-domain base path.
    const route = `${event.httpMethod} ${event.resource}`;
    switch (route) {
      case 'GET /.well-known/oauth-protected-resource':
      case 'GET /.well-known/oauth-protected-resource/mcp':
        return json(
          200,
          protectedResourceMetadata(deps.config()),
          METADATA_CACHE,
        );
      case 'GET /.well-known/oauth-authorization-server':
      case 'GET /.well-known/openid-configuration':
        return json(
          200,
          authorizationServerMetadata(deps.config()),
          METADATA_CACHE,
        );
      case 'POST /register': {
        let body: unknown;
        try {
          body = parseBody(event);
        } catch {
          return json(400, {
            error: 'invalid_client_metadata',
            error_description: 'body is not valid JSON',
          });
        }
        const result = await registerClient(
          deps.cognito(),
          deps.config(),
          body,
        );
        return json(result.status, result.body, {
          'cache-control': 'no-store',
        });
      }
      case 'GET /authorize':
        return {
          statusCode: 302,
          headers: {
            location: authorizeRedirect(
              deps.config(),
              event.multiValueQueryStringParameters,
            ),
            'cache-control': 'no-store',
          },
          body: '',
        };
      case 'POST /token': {
        const raw = event.body
          ? event.isBase64Encoded
            ? Buffer.from(event.body, 'base64').toString('utf8')
            : event.body
          : undefined;
        const result = await forwardToken(
          deps.fetch ?? fetch,
          deps.config(),
          raw,
        );
        return {
          statusCode: result.status,
          headers: {
            'content-type': result.contentType,
            'cache-control': 'no-store',
            pragma: 'no-cache',
          },
          body: result.body,
        };
      }
      default:
        return json(404, { error: 'not_found' });
    }
  };
}

export const handler = createOAuthHandler({
  config: loadConfig,
  cognito: defaultCognito,
});
