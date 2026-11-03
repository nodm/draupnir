## Context

- `mcp/src/lib/mcp.ts` registers one tool (`whoami`) via
  `server.registerTool(name, { description }, handler)`. It resolves the caller
  from `ctx.http?.authInfo?.extra?.sub` (`callerSub`, falling back to
  `'unknown'` for display). The Lambda adapter (`handler.ts`) takes identity
  only from the API Gateway authorizer claims.
- After the preceding changes:
  - the `DataTool` definitions (`name`, `description`, `inputSchema`,
    `run(ctx, input)`) live in `shared/src/lib/dataTools/`, with keyset
    pagination, limits, and untrusted-text marking defined by the `data-tools`
    spec;
  - `withCaller(sub, fn)` and the Data API helper live in `shared`;
  - application Lambdas use the `draupnir_app` secret, and RLS applies.
- `mcp` has no database wiring today.

## Goals / Non-Goals

**Goals:**
- Expose the shared tools over MCP with zero data logic in `mcp`.
- Fail closed on a missing identity.

**Non-Goals:**
- MCP OAuth discovery and client registration (CIMD/DCR) for Claude clients.
  Clients keep using a Cognito JWT obtained out of band, as `whoami` does today.
- Write tools, MCP resources or prompts.
- Changes to tool behavior (owned by `data-tools`).

## Decisions

### 1. A thin adapter from `DataTool` to `registerTool`

```ts
for (const tool of DATA_TOOLS) {
  server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema },
    async (args, ctx) => {
      const sub = resolveCallerSub(ctx.http?.authInfo);
      if (!sub) return toolError('Unauthenticated: no caller identity');
      try { return toolResult(await tool.run({ sub, db }, args)); }
      catch (e) { return toolError(messageOf(e)); }
    });
}
```

- Results are returned as structured content plus a JSON text block, so clients
  without structured-output support still read them. Validation errors from the
  shared tool become MCP tool errors (`isError: true`), not JSON-RPC errors, per
  the spec's "returned as a tool error".
- The shared tools' JSON Schemas are passed through unchanged. If the MCP SDK v2
  `registerTool` requires a zod schema instead of JSON Schema, convert at the
  adapter. That is a mechanical detail confirmed at implementation time against
  the SDK docs, not a behavior change.

### 2. `resolveCallerSub` alongside `callerSub`

`callerSub` returns `'unknown'` for `whoami`'s display. That value is
indistinguishable from a real (if unlikely) `sub` further down the stack.
`resolveCallerSub(authInfo): string | undefined` returns `undefined` when there
is no claim, and the adapter refuses before any query (spec: "no sub, no
query"). `whoami` and `callerSub` stay as they are.

### 3. Database access

- `db` is a module-scope `{ client: RDSDataClient, config: loadDataApiConfigFromEnv() }`
  built once per cold start. The shared tool runs its queries inside
  `withCaller(sub, …)` itself.
- IAM:
  - `rds-data:ExecuteStatement`, `BeginTransaction`, `CommitTransaction`, and
    `RollbackTransaction` on the cluster (`withCaller` uses transactions);
  - `secretsmanager:GetSecretValue` on the `draupnir_app` secret only;
  - no `BatchExecuteStatement` (read-only).
- Reuse `dataApiPolicyStatements` if it can be parameterized by action list;
  otherwise add an explicit read-only variant next to it.
- The `mcp` Lambda already `dependsOn` the migration Invocation
  (`add-db-migrations`), so it never runs against an older schema.

## Risks / Trade-offs

- **Tool latency over MCP with a paused cluster** (resume up to ~1 min, plus the
  four Data API calls in `withCaller`). → The `mcp` route has the same 29s API
  Gateway ceiling as ingestion. A first call after a long idle can time out,
  and the client's retry succeeds. Accepted for occasional use, as elsewhere.
- **MCP clients still need a manually obtained Cognito JWT** (no OAuth
  discovery). → Unchanged from today and documented. Solving it is a separate
  change.
- **Two AI surfaces now share tools, so a breaking tool change affects both.** →
  This is intended: one contract, covered by the `data-tools` tests.

## Migration Plan

- Additive: tool registrations, env vars, IAM on the existing `mcp` Lambda. No
  schema change.
- Rollback: revert and redeploy. The tools are read-only, so there is no data
  to clean up.
