## Why

After `redesign-statement-data-model`, the rule "a user sees only accounts they
are a member of" is still enforced only by application code: every query has to
include the membership predicate. A single query that forgets it (a new MCP
tool, a bot command, the AI chat's data tools) returns everyone's data, and
nothing below the application stops it. For a financial app shared by two
people, the database should enforce this as well, so the application filter and
the database policy each catch the other's mistakes.

Depends on `redesign-statement-data-model` (policies target its tables).

## What Changes

- Enable Postgres Row Level Security on every account-scoped table:
  - `accounts`, `account_members`;
  - `statement_file_accounts`, `raw_rows`;
  - `transactions`, `transaction_sources`;
  - `statement_files` (approved files are visible to members of the upload
    account, since rebuilds and duplicate checks need every owner's files;
    rejected files only to their uploader, since rejection reasons can quote
    other accounts' rows).

  Rows are visible only when the caller is a member of the row's account.
  Writes require `owner` membership, except creating a brand-new account,
  which makes the caller its first owner.
- Fail closed: a request that hasn't identified its caller sees no rows and can
  write none.
- A dedicated application database role (`draupnir_app`) is used by every
  application Lambda. It doesn't own the tables and can't bypass RLS. The
  existing master credential is used only by the migration runner.
- Every application database call runs inside a Data API transaction that first
  sets the caller's identity for that transaction only (`withCaller(sub, fn)`).
  The ingestion worker sets it from the S3 object key's `sub`.
- The last owner of an account can't be removed or demoted, enforced by a
  trigger (migration `0006`).
- A `not-owner` rejection (the uploader lost ownership or can't see the account) is reported but not
  recorded, since a non-owner can't write `statement_files`.
- Application-level membership predicates stay in queries (defence in depth).

## Capabilities

### New Capabilities
(none)

### Modified Capabilities
- `statement-ingestion-pipeline`: adds the unrecorded `not-owner` rejection.
- `row-level-authorization`: adds database-level enforcement of membership
  visibility, owner-only writes, fail-closed behavior when no caller is
  identified, and per-transaction identity scoping.
- `aurora-data-access`: adds the requirement that application code connects
  with a non-owner role that can't bypass RLS, distinct from the master
  credential.

## Impact

- `shared/src/lib/`:
  - migration `0003`: the role, grants, `SECURITY DEFINER` membership
    function, policies, and an account-creation function;
  - a `withCaller` helper in `dataApi.ts`.
- `ingestion/src/lib/`: every handler's database access is routed through
  `withCaller`. A single-statement read becomes four Data API calls (begin,
  set identity, statement, commit), which adds latency per request.
- `infra/lib/aurora.ts`: second Secrets Manager secret for `draupnir_app`
  (generated password). The migration runner sets the role's password from it.
- `infra/lib/`: application Lambdas switch `DB_SECRET_ARN` to the app secret;
  the migration Lambda keeps the master secret.
- Later changes add RLS on their own tables, following the same pattern:
  - `add-telegram-bot`: `messenger_links`;
  - `add-bot-ai-chat`: chat history, pending actions.
