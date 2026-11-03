## Why

The live Aurora schema exists only because someone ran DDL by hand via
`rds-data execute-statement` during `provision-aurora-cluster` — and that manual
step already failed once: `share_grants` (`shared/src/lib/shareGrants.ts`) was
defined and tested but never applied, so `ownershipPredicate` would fail against
production today. The next planned changes (`redesign-statement-data-model`,
`add-row-level-security`, `add-telegram-bot`, `add-bot-ai-chat`) all add or
reshape tables, roles, and policies; doing that by hand again is not viable.

This is also the first change built on the decision to stay on AWS rather than
move to Supabase/Cloudflare, so it records that decision as ADR-0007.

## What Changes

- Add an ordered, append-only list of database migrations in `shared`, each a
  named list of SQL statements. Migration `0001` adopts the current live schema
  (`accounts`, `transactions`) and finally creates `share_grants`.
- Add a `schema_migrations` table recording each applied migration's id,
  checksum, and applied time.
- Add a migration runner that applies pending migrations through RDS Data API —
  each migration atomically with its `schema_migrations` row, serialized by an
  advisory lock, refusing to run if an already-applied migration's content has
  changed.
- Run the runner automatically on `pulumi up` (a migration Lambda invoked by
  Pulumi whenever the migration set changes), before application Lambdas are
  updated; a failed migration fails the deploy.
- Make migrations the single source of truth for schema: the
  `ACCOUNTS_TABLE_DDL` / `TRANSACTIONS_TABLE_DDL` / `SHARE_GRANTS_TABLE_DDL`
  constants are replaced, and schema tests apply the migration list to pglite.
- Move the Data API helper (`ingestion/src/lib/dataApi.ts`) into `shared` so the
  runner, `ingestion`, and later `mcp` share one implementation.
- Write ADR-0007: stay on AWS (vs. Supabase free tier, vs. Supabase + Cloudflare).

## Capabilities

### New Capabilities
- `db-migrations`: how schema changes are defined, recorded, and applied to the
  Aurora cluster — ordering, atomicity, immutability of applied migrations,
  concurrency safety, and running as part of deployment.

### Modified Capabilities
(none — table shapes in `transactions-schema` and `row-level-authorization` are
unchanged; this change only changes how that schema reaches the database)

## Impact

- `shared/src/lib/`: new `migrations/` (ordered list + `0001`), Data API helper
  moved here; DDL constants removed; `shared` gains a dependency on
  `@aws-sdk/client-rds-data`.
- `ingestion/src/lib/`: imports the Data API helper from `shared` instead of its
  local `dataApi.ts`; no behavior change.
- `infra/src/`: new migration Lambda handler; `infra/project.json`: new esbuild
  target, added to `preview`/`up` `dependsOn`.
- `infra/lib/`: migration Lambda (no VPC, Data API + secret read permissions
  only), Pulumi-invoked on migration-set change; ingestion/mcp Lambdas depend on
  that invocation.
- Live cluster: `schema_migrations` and `share_grants` are created on first run;
  existing `accounts`/`transactions` rows are untouched.
- `openspec/changes/add-mcp-data-tools` no longer needs its own `share_grants`
  bootstrap or Data API copy (revised to build on the later changes).
- Docs: `docs/adr/0007-stay-on-aws.md`; `docs/architecture.md` gains the
  migration Lambda.
