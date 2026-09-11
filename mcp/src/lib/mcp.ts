import {
  createMcpHandler,
  McpServer,
  type AuthInfo,
} from '@modelcontextprotocol/server';

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
      const sub = ctx.http?.authInfo?.clientId;
      return { content: [{ type: 'text', text: sub ?? 'unknown' }] };
    },
  );

  return server;
}

export const mcpHandler = createMcpHandler(buildServer);

// API Gateway's Cognito authorizer has already verified the JWT before the
// Lambda runs; this only shapes its injected `sub` claim into the AuthInfo
// shape the SDK expects for `ctx.http.authInfo` — it never re-verifies a
// token, and never reads an identity from anywhere but this claim.
export function authInfoForSub(sub: string): AuthInfo {
  return { token: sub, clientId: sub, scopes: [] };
}
