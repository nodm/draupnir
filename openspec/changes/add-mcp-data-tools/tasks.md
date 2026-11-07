## 1. Caller identity

- [x] 1.1 Add `resolveCallerSub(authInfo): string | undefined` to `mcp/src/lib/mcp.ts` next
      to the unchanged `callerSub`; verify unit tests for a present and an absent sub claim.

## 2. Tool exposure

- [x] 2.1 Add `shared` and `@aws-sdk/client-rds-data` to `mcp/package.json` and the module-scope
      Data API context (`loadDataApiConfigFromEnv`); verify `pnpm install` and
      `pnpm exec nx run mcp:build` succeed and `dist/mcp` contains the runtime dependency
      after `mcp:install-deps`.
- [x] 2.2 Implement the `DataTool` → `registerTool` adapter (design.md decision 1) and
      register every tool in `DATA_TOOLS`; verify in-process `tools/call` tests over
      `StreamableHTTPClientTransport` (pglite-backed or mocked shared tools): `tools/list`
      contains `whoami` and the four tools; a viewer sees the shared account; result equals
      the shared tool's for the same input; limit above maximum returns a tool error; a
      body-supplied `sub` is ignored; an unresolved sub returns a tool error and the
      database/tool `run` is never called (asserted with a mock).
- [x] 2.3 Verify `pnpm exec nx run mcp:test` passes with `whoami`'s existing tests unchanged.

## 3. Infra

- [x] 3.1 Extend `infra/lib/mcpApi.ts`: DB env vars with the `draupnir_app` secret,
      IAM for `ExecuteStatement`/`BeginTransaction`/`CommitTransaction`/`RollbackTransaction`
      on the cluster and `GetSecretValue` on the app secret only, `{ provider }` on new
      resources; verify `pnpm exec nx run infra:build` and `infra:preview` show only
      additive IAM statements and env vars on the `mcp` Lambda.
- [x] 3.2 `pnpm exec nx run infra:up`; verify the deploy completes without replacing the
      `mcp` Lambda or API.

## 4. End-to-end

- [x] 4.1 With a real Cognito JWT for a user who owns accounts, call each
      data tool against the deployed endpoint; verify `list_transactions` pagination
      round-trips with no duplicate row and an `accountId` the user can't see returns
      an empty list. (Run 2026-11-06 against prod with an owner-only user.)
- [ ] 4.2 With a real Cognito JWT for a user who owns one account and views another, call each
      data tool against the deployed endpoint; verify only that user's visible rows are
      returned. (Viewer scoping is covered by shared and mcp pglite tests, not yet end to end.)
