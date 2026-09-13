## Why

`provision-mcp-base-api` shipped the deployed transport (Lambda + API Gateway +
Cognito authorizer) with only a proof-of-wiring `whoami` tool; its design.md
explicitly deferred real data tools to a follow-up. Right now the `mcp` server
exposes no way for an MCP client to read a user's own accounts or transactions —
this change adds that.

## What Changes

- Add MCP tools `list_accounts` and `list_transactions` to `mcp/src/lib/mcp.ts`,
  registered via `server.registerTool` the same way `whoami` is.
- Both tools are read-only and scope every row to the caller: owned rows, plus
  rows shared with the caller via `share_grants`, using
  `shared`'s `ownershipPredicate` — its first real caller (`shareGrants.spec.ts`
  only exercises the generated SQL string today; no route runs it against the
  database yet).
- `list_transactions` supports filtering by `account_id` and paginates with a
  keyset cursor; `list_accounts` returns the caller's full account list
  unpaginated (see design.md for why account count doesn't need paging yet).
- Give `mcp` its own Aurora Data API wiring (`DataApiConfig` + `RDSDataClient`),
  mirroring `ingestion/src/lib/dataApi.ts` — `mcp` has none today.
- No writes, no new table/column definitions in `shared`, no changes to
  `ingestion`. This change does apply `share_grants`'s already-defined DDL to
  the live cluster for the first time (never applied by an earlier change)
  and adds two indexes to `transactions` — see Impact and design.md.

## Capabilities

### New Capabilities
- `mcp-data-tools`: the `list_accounts` and `list_transactions` MCP tools —
  their input/output shape, row-level scoping via ownership + share grants, and
  `list_transactions`'s account filter and pagination.

### Modified Capabilities
(none — `mcp-server-api`'s transport/auth requirements are unchanged; this
change only adds tools on top of that existing wiring)

## Impact

- `mcp/src/lib/mcp.ts`: register `list_accounts`/`list_transactions`, read
  `ctx.http?.authInfo?.extra?.sub` the same way `callerSub` does for `whoami`.
- `mcp/src/lib/`: new Data API wiring (config loader, `RDSDataClient` construction)
  and query helpers for the two tools, mirroring `ingestion/src/lib/dataApi.ts`.
- `mcp/package.json`: new dependency on `@aws-sdk/client-rds-data`.
- `infra/`: `mcp`'s Lambda needs `DB_CLUSTER_ARN`/`DB_SECRET_ARN`/`DB_NAME` env
  vars and Data API IAM permissions granted to `ingestion`'s Lambda today —
  wire the same grants onto `mcp`'s role.
- Live cluster: apply `share_grants`'s already-defined DDL for the first time
  (a prerequisite — no earlier change applied it, see design.md's Context),
  and add two indexes to `transactions` supporting the keyset query
  (design.md's Decisions). Neither is a new table/column definition in code.
- No changes to `ingestion`'s API, schema, or data; no changes to `shared`'s
  exports (`ownershipPredicate` already exists and is reused as-is).
