import { RDSDataClient } from '@aws-sdk/client-rds-data';
import {
  type AuthInfo,
  type CallToolResult,
  createMcpHandler,
  McpServer,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';
import { loadDataApiConfigFromEnv } from 'shared';
import {
  DATA_TOOLS,
  DataToolError,
  type DataTool,
  type DbContext,
} from 'shared/dataTools';

function callerSub(authInfo: AuthInfo | undefined): string {
  const sub = authInfo?.extra?.['sub'];
  return typeof sub === 'string' ? sub : 'unknown';
}

// The identity a data tool runs as. Unlike `callerSub` (a display value for
// `whoami`), an absent claim stays `undefined` so the adapter can refuse
// before any query.
export function resolveCallerSub(
  authInfo: AuthInfo | undefined,
): string | undefined {
  const sub = authInfo?.extra?.['sub'];
  return typeof sub === 'string' && sub !== '' ? sub : undefined;
}

export interface McpDeps {
  tools: readonly DataTool[];
  // Lazy: the Data API config comes from env vars that only exist deployed.
  getDb: () => DbContext;
}

let cachedDb: DbContext | undefined;
function defaultDb(): DbContext {
  cachedDb ??= {
    client: new RDSDataClient({}),
    config: loadDataApiConfigFromEnv(),
  };
  return cachedDb;
}

const defaultDeps: McpDeps = { tools: DATA_TOOLS, getDb: defaultDb };

function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function toolResult(value: unknown): CallToolResult {
  const isObject =
    typeof value === 'object' && value !== null && !Array.isArray(value);
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    ...(isObject
      ? { structuredContent: value as Record<string, unknown> }
      : {}),
  };
}

// `registerTool` wants a Standard Schema; the shared tools publish JSON Schema
// and validate input themselves (`run`), so this only advertises the schema
// and passes arguments through untouched.
function passthroughSchema(jsonSchema: Record<string, unknown>) {
  return {
    '~standard': {
      version: 1 as const,
      vendor: 'draupnir',
      validate: (value: unknown) => ({ value }),
      jsonSchema: { input: () => jsonSchema, output: () => jsonSchema },
    },
  };
}

// Only the caller-fixable shared-tool errors are shown; anything else is an
// unexpected fault whose detail stays in the logs.
function messageOf(e: unknown): string {
  if (e instanceof DataToolError) {
    return e.message;
  }
  console.error('data tool failed', e);
  return 'Internal error';
}

export function buildServer(deps: McpDeps = defaultDeps): McpServer {
  const server = new McpServer({ name: 'draupnir-mcp', version: '0.0.1' });

  server.registerTool(
    'whoami',
    { description: "Report the authenticated caller's Cognito sub" },
    async (ctx) => {
      return {
        content: [{ type: 'text', text: callerSub(ctx.http?.authInfo) }],
      };
    },
  );

  // No data logic here: each shared tool is adapted to MCP and run as the
  // authorizer-identified caller.
  for (const tool of deps.tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: passthroughSchema(tool.inputSchema),
      },
      async (args, ctx) => {
        const sub = resolveCallerSub(ctx.http?.authInfo);
        if (!sub) {
          return toolError('Unauthenticated: no caller identity');
        }
        try {
          return toolResult(await tool.run({ sub, db: deps.getDb() }, args));
        } catch (e) {
          return toolError(messageOf(e));
        }
      },
    );
  }

  return server;
}

export function createHandler(deps: McpDeps): McpHttpHandler {
  return createMcpHandler(() => buildServer(deps));
}

export const mcpHandler: McpHttpHandler = createHandler(defaultDeps);

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
