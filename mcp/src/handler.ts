import type {
  APIGatewayProxyResult,
  APIGatewayProxyWithCognitoAuthorizerEvent,
  Handler,
} from 'aws-lambda';
import { authInfoForSub, mcpHandler } from './lib/mcp';

export class UnauthenticatedError extends Error {
  constructor() {
    super('Authenticated request is missing a sub claim');
    this.name = 'UnauthenticatedError';
  }
}

function requireSub(claims: { [name: string]: string }): string {
  const sub = claims['sub'];
  if (!sub) {
    throw new UnauthenticatedError();
  }
  return sub;
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
  let sub: string;
  try {
    sub = requireSub(event.requestContext.authorizer.claims);
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return { statusCode: 401, body: JSON.stringify({ error: error.message }) };
    }
    throw error;
  }

  const response = await mcpHandler.fetch(toRequest(event), {
    authInfo: authInfoForSub(sub),
  });

  return toProxyResult(response);
};
