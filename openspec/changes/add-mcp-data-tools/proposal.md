## Why

`provision-mcp-base-api` shipped the deployed MCP transport (Lambda + API
Gateway + Cognito authorizer) with only a proof-of-wiring `whoami` tool. MCP
clients (Claude Desktop, Claude Code) still can't read any of the user's data.
`add-bot-ai-chat` defines the read-only data tools once, in `shared`, for the
Telegram AI chat. Exposing the same tools over MCP gives both AI surfaces
exactly the same, caller-scoped view of the data, without a second
implementation.

Depends on `add-bot-ai-chat` (tool definitions, indexes) and, through it, on
`add-db-migrations`, `redesign-statement-data-model`, and
`add-row-level-security`.

## What Changes

- Register the shared `data-tools` (`list_accounts`, `list_transactions`,
  `summarize_transactions`, `get_account_coverage`) on the MCP server in
  `mcp/src/lib/mcp.ts`, through a thin adapter to `server.registerTool`
  (schema, description, handler, error mapping). `mcp` contains no data logic.
- Every tool call runs as the caller via `withCaller(sub)`, with `sub` taken
  only from the authorizer-injected claim (`resolveCallerSub`). An unresolved
  `sub` returns a tool error without querying.
- `mcp`'s Lambda gets Data API access with the `draupnir_app` credential (RLS
  applies), using `shared`'s Data API helper.
- `whoami` is unchanged.
- Out of scope: MCP OAuth discovery / client registration for Claude clients
  (ADR-0001/0002's open item). Any write tools.

## Capabilities

### New Capabilities
- `mcp-data-tools`: how the MCP server exposes the shared `data-tools`, which
  tools, where the identity comes from, and behavior without an identity. The
  tools' own inputs, outputs, and scoping are defined by `data-tools`.

### Modified Capabilities
(none — `mcp-server-api`'s transport and auth requirements are unchanged)

## Impact

- `mcp/src/lib/mcp.ts`: `resolveCallerSub`, the tool adapter, and registration.
- `mcp/package.json`: depends on `shared` (already allowed by module
  boundaries) and `@aws-sdk/client-rds-data` (runtime dependency of the shared
  helper, installed by the existing `install-deps` target).
- `infra/lib/mcpApi.ts`:
  - `DB_CLUSTER_ARN` / `DB_SECRET_ARN` (app secret) / `DB_NAME` env vars;
  - IAM for `rds-data:ExecuteStatement`, `BeginTransaction`,
    `CommitTransaction`, and `RollbackTransaction` on the cluster;
  - `secretsmanager:GetSecretValue` on the app secret only.
- No schema changes: indexes and tables come from earlier changes.
