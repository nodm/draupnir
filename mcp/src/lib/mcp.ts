import {
  type AuthInfo,
  createMcpHandler,
  McpServer,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';

function callerSub(authInfo: AuthInfo | undefined): string {
  const sub = authInfo?.extra?.['sub'];
  return typeof sub === 'string' ? sub : 'unknown';
}

// No tools/resources for transaction/account data exist yet (see
// provision-mcp-base-api's design.md) — `whoami` exists only to prove a
// Cognito claim reaches a registered tool through the Streamable HTTP
// transport end-to-end.
function buildServer(): McpServer {
  const server = new McpServer({ name: 'draupnir-mcp', version: '0.0.1' });

  server.registerTool(
    'whoami',
    { description: "Report the authenticated caller's Cognito sub" },
    async (ctx) => {
      return { content: [{ type: 'text', text: callerSub(ctx.http?.authInfo) }] };
    },
  );

  return server;
}

export const mcpHandler: McpHttpHandler = createMcpHandler(buildServer);

// API Gateway's Cognito authorizer has already verified the JWT before the
// Lambda runs; this only shapes its injected claims into the AuthInfo shape
// the SDK expects for `ctx.http.authInfo` — it never re-verifies a token.
//
// `token`/`clientId` keep their SDK meanings (the bearer token and the OAuth
// client id, from the `aud`/`client_id` claim) rather than being repurposed
// for the end user's identity — the Cognito `sub` belongs in `extra`, where
// tool handlers (and any future SDK auth/scoping logic) can't mistake it for
// a client id.
export function authInfoFromClaims(
  claims: { [name: string]: string },
  token: string,
): AuthInfo {
  return {
    token,
    clientId: claims['aud'] ?? claims['client_id'] ?? '',
    scopes: claims['scope'] ? claims['scope'].split(' ') : [],
    extra: { sub: claims['sub'] },
  };
}
