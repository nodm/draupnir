import type {
  APIGatewayProxyResult,
  APIGatewayProxyWithCognitoAuthorizerEvent,
  Handler,
} from 'aws-lambda';
import { authInfoFromClaims, mcpHandler } from './lib/mcp';

export class UnauthenticatedError extends Error {
  constructor() {
    super('Authenticated request is missing a sub claim');
    this.name = 'UnauthenticatedError';
  }
}

function requireSub(claims: { [name: string]: string }): void {
  if (!claims['sub']) {
    throw new UnauthenticatedError();
  }
}

function bearerToken(event: APIGatewayProxyWithCognitoAuthorizerEvent): string {
  const headers = event.headers ?? {};
  const header = headers['Authorization'] ?? headers['authorization'] ?? '';
  return header.replace(/^Bearer\s+/i, '');
}

// API Gateway delivers the request as a parsed event, not raw HTTP — this
// reconstructs the web-standard Request createMcpHandler expects. The origin
// is a placeholder: the SDK only reads path/method/headers/body off it, it's
// never dereferenced.
function toRequest(event: APIGatewayProxyWithCognitoAuthorizerEvent): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) {
      headers.set(name, value);
    }
  }

  const body = event.body
    ? event.isBase64Encoded
      ? Buffer.from(event.body, 'base64')
      : event.body
    : undefined;

  return new Request(`https://mcp.invalid${event.path}`, {
    method: event.httpMethod,
    headers,
    body,
  });
}

async function toProxyResult(
  response: Response,
): Promise<APIGatewayProxyResult> {
  return {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: await response.text(),
  };
}

export const handler: Handler<
  APIGatewayProxyWithCognitoAuthorizerEvent,
  APIGatewayProxyResult
> = async (event) => {
  const claims = event.requestContext.authorizer.claims;
  try {
    requireSub(claims);
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return { statusCode: 401, body: JSON.stringify({ error: error.message }) };
    }
    throw error;
  }

  const response = await mcpHandler.fetch(toRequest(event), {
    authInfo: authInfoFromClaims(claims, bearerToken(event)),
  });

  return toProxyResult(response);
};
