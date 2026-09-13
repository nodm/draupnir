## Context

`mcp/src/lib/mcp.ts` currently registers one tool (`whoami`) via
`server.registerTool(name, { description }, handler)`, resolving the caller
from `ctx.http?.authInfo?.extra?.sub` (`callerSub`, falling back to
`'unknown'`). `mcp` has no database wiring at all today — no `DataApiConfig`,
no `RDSDataClient`. `ingestion` already has this in `ingestion/src/lib/dataApi.ts`
(a narrow wrapper over `@aws-sdk/client-rds-data`'s `ExecuteStatement`/
`BatchExecuteStatement`, per ADR-0003) and its Lambda already holds the IAM
grants and `DB_CLUSTER_ARN`/`DB_SECRET_ARN`/`DB_NAME` env vars for it
(`infra/lib/ingestionApi.ts`).

`shared/src/lib/shareGrants.ts` exports `ownershipPredicate(tableAlias,
resourceType)`, which returns a SQL fragment: `alias.owner_user_id = :sub OR
EXISTS (... share_grants ... resource_type = '<type>' AND resource_id =
alias.id)`. `ResourceType` is `'account' | 'category'` — there is no
`'transaction'` type, because `transactions-schema`'s spec fixes a
transaction's `owner_user_id` to always equal its account's owner, never a
grantee's (see `transactionsSchema.ts`'s composite FK comment). Today this
function is only exercised by `shareGrants.spec.ts` against the literal SQL
string; no route runs it against a real database. See proposal.md - Why/What
Changes for motivation.

## Goals / Non-Goals

**Goals:**
- Add `list_accounts`/`list_transactions` tools scoped by ownership + share
  grants, per specs/mcp-data-tools/spec.md.
- Give `mcp` its own Data API access, reusing `ingestion`'s pattern rather than
  inventing a new one.
- Make a concrete pagination decision for `list_transactions` (deferred by the
  proposal's scope note) rather than leaving it open.

**Non-Goals:**
- No writes, no new tables, no changes to `share_grants`'s `ResourceType`
  union.
- No pagination for `list_accounts` — see Decisions for why.
- No changes to `ingestion`'s routes, schema, or Data API wrapper itself;
  `mcp` gets its own copy of the wiring, not a shared package extraction (see
  Decisions).
- No MCP resources, only tools; no `category` data tool (out of scope — this
  change covers accounts/transactions only, per the proposal).

## Decisions

- **Join `transactions` to `accounts` and apply `ownershipPredicate('a',
  'account')` against the account row, not the transaction row.** A
  transaction's own `owner_user_id` is always the account owner's, never a
  grantee's, so applying the predicate directly to `transactions` would miss
  every transaction on a shared account. `ResourceType` has no `'transaction'`
  variant, and adding one would require every transaction to carry its own
  share-grant rows in lockstep with its account's, duplicating grant state
  that already exists once per account. Query shape:
  ```sql
  SELECT t.* FROM transactions t
  JOIN accounts a ON a.id = t.account_id
  WHERE <ownershipPredicate('a', 'account')>
    [AND t.account_id = :accountId]
    [AND (t.posted_date, t.id) < (:cursorDate, :cursorId)]
  ORDER BY t.posted_date DESC, t.id DESC
  LIMIT :limit
  ```
  `list_accounts`'s query applies `ownershipPredicate('a', 'account')` directly
  against `accounts`, since accounts are the shared resource itself.
- **Account filter checks visibility by intersecting with the same predicate,
  not a separate existence check.** Adding `t.account_id = :accountId` to the
  query above (rather than first checking "does this account exist and is it
  visible" as a separate query) means a filter naming an invisible or
  nonexistent account both fall out as an empty result through the same code
  path — no separate not-found/forbidden branch to keep in sync with the
  ownership rule, and no distinguishable error that would let a caller probe
  which account ids exist.
- **Keyset pagination on `(posted_date, id)`, not `id` alone or offset.**
  `posted_date` is the natural sort for a transaction list but is not unique,
  so a cursor needs a tiebreaker to stay stable across pages — `id` (the
  table's UUID primary key) breaks ties deterministically. Offset pagination
  was rejected: it re-scans skipped rows on every page and shifts under
  concurrent inserts (a new statement upload between two page fetches would
  skew offsets); keyset avoids both. The cursor is opaque to the caller
  (base64 of `{postedDate, id}`) so the tool can change its encoding later
  without breaking the spec-level contract ("a cursor from a previous
  response continues after that page"). An invalid/undecodable cursor is
  rejected (spec's "invalid or tampered cursor" scenario) rather than treated
  as "start from the beginning," so a corrupted cursor fails loudly instead of
  silently re-serving page one.
- **Default page size 50, max 200.** Chosen to keep a single MCP tool
  response comfortably under typical LLM context/tool-result size limits
  while still returning enough rows to be useful for a statement-review
  query; both are implementation constants, not spec-level behavior, so they
  live in code rather than the spec (the spec only commits to "a bounded page
  size, default or caller-supplied").
- **`list_accounts` stays unpaginated.** Unlike transactions (potentially
  thousands per user), accounts are bounded by how many bank accounts a
  person realistically holds (single digits to low tens, even across every
  shared grant) — a page-size ceiling would add cursor-handling complexity for
  a list that never approaches it. Revisit if share grants make account lists
  grow unboundedly in practice.
- **`mcp` gets its own copy of the Data API wrapper, not a shared-package
  extraction.** `ingestion/src/lib/dataApi.ts` is a thin, dependency-free
  wrapper (~190 lines) over `@aws-sdk/client-rds-data`; extracting it into
  `shared` now would couple `shared` (currently DB-client-free, imported by
  both Lambdas for schema/predicate constants only) to an AWS SDK dependency
  for two call sites. Duplicating the wrapper is the smaller change; revisit
  extraction if a third consumer appears.
- **New IAM/env wiring on `mcp`'s Lambda mirrors `ingestion`'s exactly**
  (`DB_CLUSTER_ARN`/`DB_SECRET_ARN`/`DB_NAME`, `rds-data:ExecuteStatement`/
  `BatchExecuteStatement` on the same cluster/secret). No new Data API
  transactions (`BeginTransaction`/`Commit`/`Rollback`) are needed — every
  query here is a single read statement.

## Risks / Trade-offs

- [Two independent copies of the Data API wrapper can drift (e.g. a bug fix
  landing in `ingestion`'s but not `mcp`'s)] → Accepted per the
  no-shared-package decision above; small enough surface (~190 lines) to
  keep in sync by inspection, revisit if it grows.
- [`ownershipPredicate`'s SQL-fragment interpolation of `resourceType` into
  the query string relies on `ResourceType` staying a closed, code-controlled
  union rather than user input] → Already true today (`shareGrants.ts`'s type
  signature), unchanged by this proposal; both call sites here pass the
  literal `'account'`.
- [Keyset cursor encodes `posted_date`+`id` in a way callers could attempt to
  hand-craft] → Not a security boundary: the cursor only narrows which of the
  caller's *own already-visible* rows come next: The ownership predicate is
  still applied on every call regardless of cursor content, so a
  hand-crafted cursor can only skip to a different valid position within the
  caller's own results, never surface another user's row.

## Migration Plan

- Additive only: new tool registrations, new `mcp`-local Data API module, new
  IAM policy statements and env vars on `mcp`'s existing Lambda. No schema
  migration, no data backfill.
- Rollback: revert the commit and redeploy; no data written by this change to
  clean up (read-only tools).
