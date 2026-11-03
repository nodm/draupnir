## 1. Database objects

- [ ] 1.1 Add migration `0003-row-level-security` to `MIGRATIONS`: `draupnir` schema,
      `current_sub()`, `is_member()` (SECURITY DEFINER, pinned `search_path`),
      `create_account()`, `ALTER TABLE … ENABLE ROW LEVEL SECURITY` and the policies from
      design.md decision 4, grants to `draupnir_app` (role created by the runner, decision 1)
      excluding `schema_migrations`; verify the migration applies to pglite after `0001`/`0002`.

## 2. Policy tests

- [ ] 2.1 Spike: confirm pglite supports `CREATE ROLE`, `SET ROLE` to a non-owner, and policy
      enforcement; if not, add a disposable Postgres container test setup matching Aurora's
      major version and use it for this group. Verify a trivial policy test passes either way.
- [ ] 2.2 Tests as `draupnir_app` for every `row-level-authorization` scenario added by this
      change: filterless query isolation, viewer visibility, viewer write rejected, account
      creation via `create_account` makes the caller owner, self-add to another account
      rejected, no identity → zero rows and writes rejected, identity not carried into the
      next transaction on the same session.
- [ ] 2.3 Guard test: every table in `public` except `schema_migrations` has RLS enabled and at
      least one policy; verify it fails when a table without policies is added in a scratch
      migration, then remove the scratch migration.

## 3. Application wiring

- [ ] 3.1 Add `withCaller(client, config, sub, fn)` to `shared/src/lib/dataApi.ts` (design.md
      decision 2); verify unit tests with a mocked `RDSDataClient`: call order (begin →
      set_config with `true` → body → commit), rollback on body error, `sub` bound as a
      parameter.
- [ ] 3.2 Route every database access in `ingestion` through `withCaller` (API handlers: `sub`
      from claims; worker: `sub` from the object key; rebuild handler: `sub` from payload) and
      replace account creation with `draupnir.create_account`; verify existing ingestion
      tests pass and a grep finds no `executeStatement`/`batchExecuteStatement` call outside a
      `withCaller` body.

## 4. Infra and deploy

- [ ] 4.1 Add `@pulumi/random`; in `infra/lib/aurora.ts` create the `draupnir_app` password and
      Data API secret; extend the migration runner with the idempotent ensure-role step
      (password read from a transaction-local setting, not interpolated) and read access to
      that secret, and include the secret version in the Invocation triggers; switch
      application Lambdas' `DB_SECRET_ARN` and IAM to the app secret; verify
      `pnpm exec nx run infra:build` and `infra:preview` show the secret, IAM, and env changes
      only, and every `aurora-data-access` scenario by inspecting the preview.
- [ ] 4.2 `pnpm exec nx run infra:up`; verify against the live cluster: `draupnir_app` owns no
      table and has no `BYPASSRLS`; a filterless `SELECT` with the app secret and no
      `withCaller` returns zero rows; two consecutive Data API transactions, the first with
      identity and the second without, show no leakage; the ingestion E2E from
      `redesign-statement-data-model` task 7.2 still passes.
- [ ] 4.3 Verify `pnpm exec nx run-many -t lint test build` passes; update
      `docs/architecture.md` (two DB credentials, RLS) and the PR checklist in
      `.github/pull_request_template.md` to mention RLS policies for new tables.
