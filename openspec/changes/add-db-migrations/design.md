## Context

Schema today lives as three string constants in `shared`
(`ACCOUNTS_TABLE_DDL`, `TRANSACTIONS_TABLE_DDL` in `transactionsSchema.ts`;
`SHARE_GRANTS_TABLE_DDL` in `shareGrants.ts`). Tests parse them with
`pgsql-ast-parser` and execute them against pglite. The live cluster got the
first two once, by hand, via `rds-data execute-statement`
(`provision-aurora-cluster` task 4.1); `share_grants` was never applied.

Constraints from earlier ADRs:
- Every database access goes through RDS Data API; no Lambda joins the VPC and
  the security group has no ingress (ADR-0003, `aurora-data-access` spec).
  There is no network path for a laptop or CI runner to open a Postgres
  connection, so a conventional migration tool that speaks the wire protocol
  (node-pg-migrate, Flyway, Prisma Migrate, …) cannot reach the cluster.
- The cluster auto-pauses after 300s idle; the first call after a pause waits
  for a resume of seconds to ~1 minute (`infra/lib/aurora.ts`).
- One deployer, one stack (`prod`), deploys via `pnpm exec nx run infra:up`.

Data API helpers already exist in `ingestion/src/lib/dataApi.ts`
(`executeStatement`, `beginTransaction`, `commitTransaction`,
`rollbackTransaction`, `loadDataApiConfigFromEnv`), and
`infra/lib/ingestionPipeline.ts` already has `dataApiPolicyStatements(dbConfig)`
for IAM. Lambdas defined in `infra/src` are bundled with an `@nx/esbuild`
target (`build-pre-sign-up-trigger` is the precedent).

## Goals / Non-Goals

**Goals:**
- One source of truth for schema that tests, a fresh database, and the live
  cluster all agree on.
- No manual DDL step in any future change.
- Deploys apply schema before code that needs it.

**Non-Goals:**
- Down/rollback migrations. Postgres DDL is transactional, so a failed
  migration already leaves no trace; undoing a *successful* one is a new
  forward migration.
- Any table or column change. `0001` reproduces today's schema exactly; the
  data-model redesign is the next change.
- Multi-environment promotion, migration CLI for ad-hoc use, or data
  migrations with large backfills.

## Decisions

### 1. Migrations are TypeScript modules in `shared`, each a list of statements

```ts
export interface Migration {
  readonly id: string;              // '0001-initial-schema'
  readonly statements: readonly string[];
}
export const MIGRATIONS: readonly Migration[] = [m0001];
```

- **Why TS, not `.sql` files:** esbuild bundles imports for free; `.sql` files
  would need asset copying into each Lambda bundle and loading at runtime.
  Tests import the same array.
- **Why a list of statements:** Data API's `ExecuteStatement` runs one
  statement per call, so splitting is required anyway; doing it in the source
  (instead of naïvely splitting on `;`) avoids breaking on semicolons inside
  function bodies or string literals that later migrations (RLS policies,
  `SECURITY DEFINER` functions) will contain.
- **Checksum:** SHA-256 over the id and statements joined with a separator,
  computed by a shared helper used by both the runner and the Pulumi trigger.
- The `*_TABLE_DDL` constants are removed; their tests are rewritten to apply
  `MIGRATIONS` to pglite. Migration `0001`'s statements are a frozen copy of
  today's DDL, using `CREATE TABLE IF NOT EXISTS` so it adopts the live cluster
  (spec: "Migration 0001 adopts the existing live schema").
- **Alternative considered:** keep the constants and reference them from `0001`.
  Rejected: the constants would then be edit-locked forever (editing one would
  change an applied migration's checksum), which is a trap.

### 2. Runner algorithm: one Data API transaction per migration, advisory lock

`acquireLock(tx)` is used in every transaction below:
- It polls `SELECT pg_try_advisory_xact_lock(<fixed key>)` every 2 seconds
  until it returns `true`.
- It never uses the blocking `pg_advisory_xact_lock`. A blocking wait could
  exceed Data API's 45-second synchronous statement timeout while another
  runner applies a long migration, and the waiting run would fail instead of
  waiting.
- Each poll is a separate short call, so the Data API transaction also never
  hits its 3-minute idle expiry.
- Polling stops at an overall deadline: when the Lambda's remaining time
  drops below 60 seconds, which leaves room to roll back. The runner then
  rolls back and fails with "timed out waiting for the migration lock".

Steps:
1. **Bootstrap transaction:** `beginTransaction` → `acquireLock` →
   `CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY,
   checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())` →
   `commitTransaction`. Holding the lock serializes concurrent first runs on a
   fresh database. `IF NOT EXISTS` alone doesn't, and two concurrent creates
   can fail on the catalog's unique index.
2. Read all recorded rows. If any recorded id's checksum differs from the
   defined migration's (or a recorded id no longer exists), fail naming it.
   This is a fast pre-check without the lock; step 3 re-checks under the lock.
3. For each defined migration not yet recorded, in id order:
   `beginTransaction` → `acquireLock` → read this id's row from
   `schema_migrations`:
   - **Recorded with the same checksum** (another run applied it while we
     waited): `rollbackTransaction` and continue with the next migration.
   - **Recorded with a different checksum** (a concurrent run deployed
     different content for this id): `rollbackTransaction` and fail naming
     the id. Silently accepting it would apply later migrations against an
     unexpected schema.
   - **Not recorded:** execute each statement, insert the `schema_migrations`
     row, then `commitTransaction`.

   On any error, `rollbackTransaction` and rethrow.
- Postgres DDL is transactional, so step 3 gives the spec's atomicity.
- The transaction-scoped advisory lock releases on commit/rollback, so a
  crashed runner can't leave a stale lock (Data API transactions also expire
  after 3 minutes idle).
- Each migration statement must itself finish within Data API's 45-second
  synchronous limit. At this data size every planned DDL does. Long-running
  backfills are out of scope (Non-Goals).
- **Alternative:** one transaction for all pending migrations. Rejected: the
  spec wants earlier migrations to stay applied when a later one fails, which
  makes failures easier to localize.
- Statements that cannot run in a transaction (e.g.
  `CREATE INDEX CONCURRENTLY`) are not supported; at this data size plain
  `CREATE INDEX` is fine.

### 3. Runner is a Lambda invoked by Pulumi, not a local script or CI job

`infra/src/migrateDatabase.ts` (handler) runs the algorithm above with the
configuration from env vars (`DB_CLUSTER_ARN`/`DB_SECRET_ARN`/`DB_NAME`).
`infra/lib/databaseMigrations.ts` defines the function (no VPC, IAM:
`dataApiPolicyStatements(dbConfig)`, timeout 5 minutes) and an
`aws.lambda.Invocation` whose `triggers` contain the combined checksum of
`MIGRATIONS`, so Pulumi invokes it exactly when the migration set changes. A
function error fails the Invocation, which fails `pulumi up`. The ingestion and
mcp Lambdas take `dependsOn` on the Invocation so they update only after
migrations succeed.

- **Alternative: local script run by the deployer.** Simplest, but it is the
  same "remember to run it" step that failed for `share_grants`, and it does
  not order schema before code.
- **Alternative: CI job.** There is no deploy pipeline in CI today
  (`ci-pipeline` spec covers lint/build/test only); adding AWS credentials to
  CI is out of scope.
- Keeps the stack all-AWS and inside ADR-0003's access model; Lambda +
  Pulumi Invocation is also a useful SAA-adjacent pattern.

### 4. Paused-cluster handling

The runner wraps each Data API call in a retry for the resume-in-progress error
(`DatabaseResumingException`), with exponential backoff capped so total waiting
stays under ~2 minutes, well inside the 5-minute timeout. Other errors are not
retried.

### 5. Data API helper moves to `shared`

`ingestion/src/lib/dataApi.ts` moves to `shared/src/lib/dataApi.ts` unchanged
and is exported from `shared`'s index; `ingestion` imports it from `shared`.
`infra` may depend on `scope:shared` (module-boundary matrix), so the runner
uses it directly, and `mcp` will reuse it later instead of a third copy. The
module-level comment about keeping `@aws-sdk/client-rds-data` contained to one
module stays true.

## Risks / Trade-offs

- [Pulumi `Invocation` runs on every `triggers` change but not on unrelated
  drift (e.g. someone drops a table by hand)] → acceptable for one deployer;
  the runner can be re-invoked manually from the console if needed.
- [Exact name and shape of the Data API resume error not yet observed in this
  stack] → verify against the live cluster in task 5.2 (deploy while paused) and
  adjust the retry predicate if the error differs.
- [`IF NOT EXISTS` in `0001` hides drift: if the live `accounts` differs from the
  defined one, `0001` silently keeps the live shape] → task 5.2 compares the live
  columns/constraints with a pglite database built from `MIGRATIONS` before
  marking the change done.
- [Removing the DDL constants touches `shared`'s public exports] → only tests
  import them today; the parked `add-mcp-data-tools` references
  `SHARE_GRANTS_TABLE_DDL` in prose and will be revised anyway.
- [Migration Lambda adds one function and IAM role] → no idle cost; it only runs
  when migrations change.

## Migration Plan

1. Merge with `0001` only; `pnpm exec nx run infra:up` creates the migration
   Lambda and invokes it: `schema_migrations` and `share_grants` appear, `0001`
   is recorded, existing rows untouched.
2. Rollback: the change adds no destructive DDL. If the runner misbehaves,
   revert the commit and redeploy; `schema_migrations` and `share_grants` can
   stay (unused) or be dropped by hand.
