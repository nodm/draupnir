## 1. Data API wiring for `mcp`

- [ ] 1.1 Add `@aws-sdk/client-rds-data` to `mcp/package.json` and verify
      `pnpm install` resolves cleanly.
- [ ] 1.2 Add `mcp/src/lib/dataApi.ts`, mirroring
      `ingestion/src/lib/dataApi.ts` (`DataApiConfig`,
      `loadDataApiConfigFromEnv`, `executeStatement`) — no transaction
      helpers needed (read-only, single-statement queries); verify unit
      tests cover parameter marshaling the same way
      `ingestion`'s does, if such tests exist there, or a minimal
      equivalent otherwise.

## 2. Query helpers

- [ ] 2.1 Implement an accounts query helper in `mcp/src/lib/` that runs
      `SELECT ... FROM accounts a WHERE <ownershipPredicate('a', 'account')>`
      via `executeStatement`, binding `:sub`; verify a unit test (mocking
      `RDSDataClient`) asserts the SQL text contains the ownership predicate
      and the caller's sub is bound as a parameter, not interpolated.
- [ ] 2.2 Implement a transactions query helper that joins `transactions t`
      to `accounts a` and applies `<ownershipPredicate('a', 'account')>`
      against the account row (per design.md's Decisions — never against
      `t.owner_user_id`), with an optional `AND t.account_id = :accountId`
      and keyset `AND (t.posted_date, t.id) < (:cursorDate, :cursorId)`,
      ordered `t.posted_date DESC, t.id DESC`, `LIMIT :limit + 1` — fetch one
      extra row and trim it before returning, using its presence (not
      `rows.length === limit`) to decide whether a `nextCursor` is emitted,
      so an exactly-full final page correctly omits the cursor (design.md's
      exact-page-boundary decision); verify unit tests cover: no filter,
      account filter, first page (no cursor), a subsequent page (with
      cursor), and the exact-page-boundary case (matching row count exactly
      equal to `limit`).
- [ ] 2.3 Implement opaque cursor encode/decode (base64 of
      `{postedDate, id}`) with a default page size of 50 and a max of 200;
      verify unit tests cover round-trip encode/decode and that an
      undecodable cursor is rejected rather than silently treated as "no
      cursor" (spec's malformed-cursor scenario) — a well-formed but
      hand-edited cursor is expected to decode and query normally (design.md:
      this is a malformed-input check, not tamper detection).
- [ ] 2.4 Add `CREATE INDEX` statements for `transactions(posted_date, id)`
      and `transactions(account_id, posted_date, id)` alongside
      `TRANSACTIONS_TABLE_DDL` in `shared/src/lib/transactionsSchema.ts`
      (design.md's index decision); verify a unit test applies the DDL
      against a test DB without error, and manually verify via `EXPLAIN`
      against the live cluster (once deployed) that 2.2's queries use an
      index scan.

## 3. Tool registration

- [ ] 3.1 Register `list_accounts` in `mcp/src/lib/mcp.ts` via
      `server.registerTool`, resolving the caller the same way `whoami`
      does (`callerSub(ctx.http?.authInfo)`), returning an empty result when
      the sub can't be resolved without querying the database; verify a
      unit test using `StreamableHTTPClientTransport` in-process
      (`tools/call` for `list_accounts` returns only rows matching the
      injected sub's ownership/share fixtures).
- [ ] 3.2 Register `list_transactions` accepting optional `accountId`,
      `limit`, and `cursor` input fields, wiring them to task 2.2/2.3's
      helpers; validate `limit` against the max from 2.3 and reject an
      out-of-range value; verify unit tests cover: default call, account
      filter (visible and invisible account), pagination across two calls,
      and an unresolved-sub call returning empty.
- [ ] 3.3 Verify (`pnpm exec nx run mcp:test`) that `whoami`'s existing
      behavior and tests are unaffected by the new registrations.

## 4. Infra wiring

- [ ] 4.1 Extend `infra/lib/mcpApi.ts` (or wherever `mcp`'s Lambda is
      defined) to set `DB_CLUSTER_ARN`/`DB_SECRET_ARN`/`DB_NAME` env vars and
      grant `rds-data:ExecuteStatement` on the cluster ARN *and*
      `secretsmanager:GetSecretValue` on the referenced secret — the two
      permissions `ingestion`'s Lambda has as separate policy statements
      (`infra/lib/ingestionPipeline.ts`); `BatchExecuteStatement` and the
      transaction actions are not needed here (design.md). Verify
      `pnpm exec nx run infra:build` succeeds.
- [ ] 4.2 Deploy to the stack `ingestion`/`mcp` already share and verify
      `pnpm exec nx run infra:preview`/`infra:up` completes without
      unexpected resource replacement (only additive IAM statements + env
      vars expected).

## 5. End-to-end verification

- [ ] 5.1 Using a real Cognito JWT, call `list_accounts` and `list_transactions`
      against the deployed endpoint for a user with at least one owned and
      one shared account; verify both tools return only that user's visible
      rows and that `list_transactions` pagination round-trips (a cursor
      from page one correctly continues into page two with no duplicate or
      missing row) against live data.
- [ ] 5.2 Call `list_transactions` with an `accountId` the caller cannot see;
      verify the live response is an empty list, not an error.
