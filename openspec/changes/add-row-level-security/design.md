## Context

- Tables from `redesign-statement-data-model`: `accounts`, `account_members`,
  `statement_files`, `raw_rows`, `transactions`, `transaction_sources`. Every
  table except `accounts`, `account_members` and `transaction_sources` has an
  `account_id`; `transaction_sources` reaches its account through
  `transactions`.
- All access goes through Data API (`shared/src/lib/dataApi.ts`). Data API
  manages its own connection pool, so session state (`SET`, `SET ROLE`) can
  persist from one request to the next on a pooled connection. Only
  transaction-scoped settings are safe.
- Today all Lambdas use the cluster's master secret
  (`infra/lib/aurora.ts`, `dataApiPolicyStatements` in
  `infra/lib/ingestionPipeline.ts`). The master user owns every table, and
  table owners bypass RLS unless `FORCE ROW LEVEL SECURITY` is set.
- Migrations run as the master user through the migration Lambda
  (`add-db-migrations`).

## Goals / Non-Goals

**Goals:**
- Database-enforced visibility and owner-only writes.
- Fail closed when the caller is unknown.
- No identity leakage across pooled sessions.

**Non-Goals:**
- Replacing application-level membership predicates. They stay as the first
  line of defence and keep query plans simple.
- Hiding cross-account uniqueness signals. `UNIQUE (iban)` still lets a caller
  learn that an IBAN exists, because unique constraints are checked against
  rows the policy hides. This is accepted: the "already exists" reason directs
  the caller to ask an owner for membership (see `account-management`).

## Decisions

### 1. Separate login role, not `SET ROLE` from the master user

`draupnir_app` is a `LOGIN` role with its own Secrets Manager secret. It is
granted DML on the application tables and `EXECUTE` on the helper functions,
owns nothing, and has no `BYPASSRLS`.

- **Alternative considered:** keep the master credential and run
  `SET LOCAL ROLE draupnir_app` inside each transaction. It needs no second
  secret, but forgetting the `SET LOCAL ROLE` silently runs with full access.
  With a separate login, forgetting `withCaller` returns nothing (see
  decision 2), so mistakes fail closed instead of open.
- **Password provisioning:**
  - Pulumi generates the password (`@pulumi/random` `RandomPassword`, new
    dependency) and stores it as a Data API–compatible JSON secret
    (`{"username":"draupnir_app","password":…}`).
  - The migration runner gets read access to that secret. Before applying
    migrations, it ensures the role exists and its password matches, using a
    `DO` block that reads the password from a transaction-local setting.
    `ALTER ROLE … PASSWORD` can't take bound parameters, and the password must
    not be interpolated into logged SQL text.
  - This "ensure role" step runs on every invocation and is idempotent. It is
    not a migration, because the password isn't static SQL. The secret's value
    is added to the Invocation's triggers hash, so a rotation re-runs it.

### 2. Caller identity: transaction-local setting, read through one function

`withCaller(client, config, sub, fn)` runs:
1. `beginTransaction`;
2. `SELECT set_config('app.sub', :sub, true)` (`true` = local to this
   transaction);
3. `fn(transactionId)`;
4. `commitTransaction` (or `rollbackTransaction` on error).

`draupnir.current_sub()` returns `NULLIF(current_setting('app.sub', true), '')`.
Every policy compares against it, and a `NULL` comparison yields no rows, so
calls outside `withCaller` see nothing (spec: "unidentified caller").

- **Cost:** four Data API round trips instead of one for a single read. That's
  acceptable at two users. If it hurts later, the next step is batching several
  reads inside one `withCaller`, not weakening the scoping.

### 3. Membership check in a `SECURITY DEFINER` function

`draupnir.is_member(account_id text, min_role text) RETURNS boolean`:
- `STABLE`, `SECURITY DEFINER`, owned by the master user;
- `SET search_path = pg_catalog, pg_temp`. `pg_temp` is listed explicitly and
  last: omitting it doesn't exclude it, because Postgres would then search the
  temporary schema *first* for relation names, and a caller-created temporary
  `account_members` table could supply fabricated memberships;
- every relation and function reference in the body is schema-qualified:
  `EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = $1 AND m.user_id = draupnir.current_sub() AND ($2 = 'viewer' OR m.role = 'owner'))`.

Running as the owner avoids recursive policy evaluation: a policy on
`account_members` that queries `account_members` would otherwise re-enter its
own policy.

**Rule for every `SECURITY DEFINER` function in this and later migrations**
(`create_account`, the bot's and AI chat's lookup and purge functions):
- `SET search_path = pg_catalog, pg_temp`;
- all references schema-qualified (`public.…`, `draupnir.…`);
- `REVOKE EXECUTE … FROM PUBLIC`, then `GRANT EXECUTE` to `draupnir_app` only.

A pglite guard test enforces the rule (decision 5).

### 4. Policies per table

| Table | SELECT | INSERT / UPDATE / DELETE |
|---|---|---|
| `accounts` | `is_member(id, 'viewer')` | no direct INSERT grant; UPDATE/DELETE `is_member(id, 'owner')` |
| `account_members` | `is_member(account_id, 'viewer')` | `is_member(account_id, 'owner')` |
| `statement_files` | `(status = 'rejected' AND uploaded_by = draupnir.current_sub()) OR (status = 'approved' AND (draupnir.is_member(upload_account_id, 'viewer') OR draupnir.is_file_member(id)))` (only rejected files carry reasons that can quote other accounts' rows; `rebuildAccount` and the duplicate-sha256 check need every member's approved files, including those uploaded for another account but resolved to this one; the uploader branch is rejected-only so a removed member can't keep reading approved metadata). Migration `0006`, since `0005` was already applied | INSERT `WITH CHECK (uploaded_by = draupnir.current_sub() AND draupnir.is_member(upload_account_id, 'owner'))`; no UPDATE/DELETE grant |
| `statement_file_accounts`, `raw_rows`, `transactions`, `transaction_sources` | `is_member(account_id, 'viewer')` | `USING` and `WITH CHECK`: `is_member(account_id, 'owner')` |

- Every account-scoped child table carries its own `account_id`.
  `transaction_sources` gets it with composite FKs to `transactions(id,
  account_id)` and `raw_rows(id, account_id)` (`redesign-statement-data-model`
  design, decision 1). Its write policy is therefore a direct owner check. An
  earlier draft reused the `transactions` visibility predicate, which includes
  viewers, and would have let a viewer write source links.
- Every INSERT/UPDATE policy states `WITH CHECK` as well as `USING`, so an
  update can't move a row into an account the caller doesn't own.

- **Account creation:** `draupnir.create_account(bank, iban, currency,
  display_name, opened_on, opening_balance)` is `SECURITY DEFINER`. It inserts
  the account and an `owner` membership for `current_sub()` in one statement,
  and raises if `current_sub()` is null. This is the only way the app role can
  insert into `accounts`, which settles the "first owner" chicken-and-egg
  problem without opening a general INSERT policy.
- `schema_migrations` gets no grant to `draupnir_app`.

### 4a. Last owner is enforced by a trigger

The generic owner write policies would let an owner delete or demote the final
owner row. A `BEFORE UPDATE OR DELETE` trigger on `account_members`
(`draupnir.keep_last_owner()`, `SECURITY DEFINER`, migration `0006`) rejects any
change that leaves an account without an owner. It locks the remaining owner
rows (`FOR UPDATE`) so two owners can't remove each other concurrently. The
application's `LastOwnerError` check stays as the first line of defence.

### 5. Guard against new tables without RLS

A pglite test asserts that every table (`relkind` `r` or `p`, so partitioned tables count) in `public` except `schema_migrations`
has RLS enabled (`pg_class.relrowsecurity`) and at least one policy. A second
guard asserts that every `SECURITY DEFINER` function in `public` and `draupnir`
has `search_path=pg_catalog, pg_temp` in `pg_proc.proconfig` and is not
executable by `PUBLIC`. Every
later change that adds a table (bot, AI chat) then fails CI until it adds
policies.

### 5a. Rejections by non-owners are not recorded

The `statement_files` INSERT policy requires owner membership of the upload
account, so the worker can't persist a `not-owner` rejection (uploader lost
ownership). The worker returns a rejected outcome with a null file id and logs
it. The decision is deterministic, so a redelivery repeats it. The same
outcome covers an upload account that isn't visible to the uploader (removed
member, or the account no longer exists): RLS makes those indistinguishable,
and a retry would only end in the DLQ.

- **Alternatives considered:** letting the uploader insert `rejected` rows
  regardless of membership, or a `SECURITY DEFINER` recording function. Both
  keep an audit row but let a non-member write rows referencing accounts they
  can't see (and leak account-id existence through FK errors).

### 6. Who sets which identity

- **API Lambdas:** `sub` from the authorizer claims.
- **Ingestion worker:** `sub` from the S3 key `uploads/{sub}/…`. This is
  trustworthy because only the presigned-URL endpoint, which checked owner
  membership, issues keys.
- **Rebuild maintenance handler:** an owner `sub` passed in the invocation
  payload.
- **Migration runner:** the master user, without RLS. It's the only component
  with that secret.

## Risks / Trade-offs

- **PGlite may not support roles and RLS exactly like Aurora PostgreSQL.** →
  Task 2.1 checks early. If pglite can't `SET ROLE` to a non-owner or doesn't
  apply policies, switch these tests to a disposable Postgres container (same
  engine major version as Aurora).
- **Data API pool session state.** → Only `set_config(..., true)` is used; the
  spec scenario "identity does not leak" is verified against the live cluster
  in task 4.2.
- **The extra round trips add latency on cold, resumed clusters.** → Acceptable;
  the API's 29s ceiling already budgets for resume.
- **Losing the app secret value locks the app out.** → Pulumi owns it; re-running
  `infra:up` re-syncs the password through the runner's ensure-role step.

## Migration Plan

1. Requires `redesign-statement-data-model` applied.
2. `infra:up`:
   - creates the app secret;
   - the runner ensures the role and applies migration `0003` (functions,
     grants, policies);
   - application Lambdas switch to the app secret afterwards (they depend on
     the migration Invocation).
3. Rollback: point Lambdas back at the master secret (they own the tables and
   bypass RLS), then add a forward migration disabling policies if needed.
