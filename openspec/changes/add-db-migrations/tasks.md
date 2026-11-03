## 1. Decision record

- [ ] 1.1 Write `docs/adr/0007-stay-on-aws.md` in the ADR-0001..0006 format (Status, Date,
      Deciders, Context, Decision, Trade-off Analysis, Consequences). Options: current AWS
      stack, Supabase free tier, Supabase + Cloudflare. Cover: SAA study goal; idle cost
      already near zero (Aurora scale-to-zero, no NAT, no VPC Lambdas) with the real monthly
      bill from Cost Explorer filled in by the user; Supabase pros (RLS with JWT wiring, Google
      auth built in, plain Postgres, low lock-in) and cons (no free backups, 7-day inactivity
      pause, $25/mo Pro, no SLA); Cloudflare pros (free Workers, MCP OAuth library, Email
      Workers, R2) and cons (free-plan CPU limit, non-Node runtime, second vendor); note that
      RLS is plain Postgres and is adopted on Aurora in a later change; revisit triggers
      (learning goal ends, or monthly bill exceeds an agreed threshold). Verify it is linked
      from the ADR list/`docs/architecture.md` the same way earlier ADRs are.

## 2. Shared Data API helper

- [ ] 2.1 Move `ingestion/src/lib/dataApi.ts` to `shared/src/lib/dataApi.ts` unchanged, export
      it from `shared/src/index.ts`, add `@aws-sdk/client-rds-data` to `shared/package.json`,
      and switch `ingestion` imports to `shared`; verify
      `pnpm exec nx run-many -t lint test build -p shared ingestion` passes with no behavior
      change.

## 3. Migration definitions

- [ ] 3.1 Add `shared/src/lib/migrations/` with the `Migration` type, `MIGRATIONS` array, and a
      `migrationChecksum`/`migrationSetChecksum` helper (SHA-256 over id + statements); verify
      unit tests: ids are unique and strictly ascending, checksum is stable for identical input
      and changes when any statement changes.
- [ ] 3.2 Add `0001-initial-schema` as a frozen copy of today's `accounts`, `transactions`, and
      `share_grants` DDL using `CREATE TABLE IF NOT EXISTS`; verify a pglite test applies
      `MIGRATIONS` to an empty database and the resulting tables satisfy every existing
      scenario in `transactionsSchema.spec.ts` and `shareGrants.spec.ts` (move those
      scenarios onto the migrated database).
- [ ] 3.3 Remove `ACCOUNTS_TABLE_DDL`, `TRANSACTIONS_TABLE_DDL`, `SHARE_GRANTS_TABLE_DDL` and
      their exports; verify `grep -rn "_TABLE_DDL" --include=*.ts` finds nothing outside
      `node_modules` and `pnpm exec nx run shared:test` passes.

## 4. Runner

- [ ] 4.1 Implement the runner in `shared/src/lib/migrations/runMigrations.ts` against a small
      executor interface (begin / execute / commit / rollback), per design.md decision 2, with
      a Data API executor (using `shared`'s `dataApi.ts`) and a pglite executor for tests.
      Verify pglite tests for every `db-migrations` scenario that is testable in-process:
      ordered apply, fresh database, idempotent re-run, failing second statement rolls back
      the whole migration and stops later ones, earlier migration stays applied, edited
      applied migration is refused with its id in the error, the "already recorded while
      waiting for the lock" re-check skips the migration when the checksum matches and fails
      naming the id when it differs (both simulated by inserting the row between the initial
      read and the per-migration transaction), and `schema_migrations` is created inside a
      bootstrap transaction that holds the lock. Lock acquisition uses
      `pg_try_advisory_xact_lock` polling: verify with a fake clock and mocked executor that
      it retries while the lock is taken, succeeds once released, and on reaching the
      deadline rolls back and fails with the lock-timeout error.
- [ ] 4.2 Add the resume retry to the Data API executor (retry only the resume-in-progress
      error, exponential backoff, ~2 minute cap); verify a unit test with a mocked
      `RDSDataClient` that fails twice with that error then succeeds, and one where a
      different error is not retried.
- [ ] 4.3 Verify `0001` adopts an existing schema: pglite test creates `accounts` and
      `transactions` with today's DDL and inserts rows, runs the runner, and asserts
      `share_grants` exists, rows are unchanged, and `0001` is recorded.

## 5. Deployment wiring

- [ ] 5.1 Add `infra/src/migrateDatabase.ts` (handler calling the runner with the Data API
      executor and `loadDataApiConfigFromEnv`), a `build-migrate-database` esbuild target in
      `infra/project.json` (same shape as `build-pre-sign-up-trigger`) added to `preview`/`up`
      `dependsOn`, and `infra/lib/databaseMigrations.ts` (Lambda without VPC, IAM from
      `dataApiPolicyStatements`, DB env vars, 5-minute timeout, `aws.lambda.Invocation`
      triggered by `migrationSetChecksum(MIGRATIONS)`); make the ingestion and mcp Lambdas
      `dependsOn` the Invocation. Verify `pnpm exec nx run infra:build` and
      `pnpm exec nx run infra:preview` show only additive resources.
- [ ] 5.2 Deploy with `pnpm exec nx run infra:up` while the cluster is paused; verify the
      Invocation succeeds after the resume, `schema_migrations` has one row for `0001`,
      `share_grants` exists, existing `accounts`/`transactions` rows are untouched, and the
      live tables' columns/constraints match a pglite database built from `MIGRATIONS`
      (compare `information_schema.columns` and `pg_constraint`). Run `infra:up` again and
      verify the Invocation is not re-run.
- [ ] 5.3 Update `docs/architecture.md` with the migration Lambda and the
      "schema before code" deploy ordering; verify the diagram renders.

## 6. Wrap-up

- [ ] 6.1 Verify `pnpm exec nx run-many -t lint test build` passes.
