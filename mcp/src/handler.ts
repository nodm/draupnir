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

// Observability for Runtime.ExitError crashes that logged nothing. Monitor
// hooks only observe: they do not change how the runtime handles a crash.
process.on('uncaughtExceptionMonitor', (error, origin) => {
  console.error(
    JSON.stringify({
      event: 'mcp-uncaught',
      origin,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }),
  );
});
process.on('exit', (code) => {
  console.error(JSON.stringify({ event: 'mcp-process-exit', code }));
});

// Request shape only: never the token or the JSON-RPC params.
function describeRequest(
  event: APIGatewayProxyWithCognitoAuthorizerEvent,
): Record<string, unknown> {
  let rpc: unknown;
  try {
    const parsed: unknown = JSON.parse(event.body ?? '');
    const methodOf = (m: unknown): unknown =>
      m && typeof m === 'object'
        ? (m as { method?: unknown }).method
        : undefined;
    rpc = Array.isArray(parsed) ? parsed.map(methodOf) : methodOf(parsed);
  } catch {
    rpc = 'unparseable';
  }
  const headers = event.headers ?? {};
  return {
    event: 'mcp-request',
    httpMethod: event.httpMethod,
    rpc,
    bodyBytes: event.body ? event.body.length : 0,
    base64: event.isBase64Encoded,
    userAgent: headers['User-Agent'] ?? headers['user-agent'],
    protocol:
      headers['mcp-protocol-version'] ?? headers['Mcp-Protocol-Version'],
  };
}

export const handler: Handler<
  APIGatewayProxyWithCognitoAuthorizerEvent,
  APIGatewayProxyResult
> = async (event) => {
  console.log(JSON.stringify(describeRequest(event)));
  const claims = event.requestContext.authorizer.claims;
  try {
    requireSub(claims);
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: error.message }),
      };
    }
    throw error;
  }

  const response = await mcpHandler.fetch(toRequest(event), {
    authInfo: authInfoFromClaims(claims, bearerToken(event)),
  });

  return toProxyResult(response);
};
