## Context

- Schema ships through `add-db-migrations` (`MIGRATIONS` in `shared`); this
  change adds migration `0002`.
- Current tables: `accounts(owner_user_id, bank, iban UNIQUE, currency,
  display_name)`, `transactions(owner_user_id, account_id, …, dedup_key UNIQUE,
  FX columns)` with a composite FK on `(account_id, owner_user_id)`, and
  `share_grants`. Live rows are test data only.
- Parsers (`ingestion/src/lib/parsers/{seb,revolut,monobank}.ts`) return
  normalized rows only. Revolut uses `Completed Date` and ignores `State`.
  `processStatementFile.ts` resolves accounts by `owner_user_id`, then inserts
  with `ON CONFLICT (dedup_key) DO NOTHING` in one Data API transaction.
- Database access is Data API only; `shared/src/lib/dataApi.ts` (moved by
  `add-db-migrations`) provides `executeStatement` / `batchExecuteStatement` /
  transactions. A single Data API request is capped at 4 MiB.
- Follow-up `add-row-level-security` adds policies on these tables, so the
  schema is designed so that every account-scoped row reaches its account in at
  most one hop.

## Goals / Non-Goals

**Goals:**
- Lossless storage of what the bank exported, plus a derived common table that
  can be rebuilt.
- Joint accounts through membership.
- Uniqueness that never spans accounts or users.
- Whole-file validation with precise reasons.

**Non-Goals:**
- RLS policies (next change). This change keeps application-level filtering:
  membership checks replace `ownershipPredicate`.
- An HTTP or bot surface for membership management (`add-telegram-bot`).
  This change provides the domain functions and tests.
- Linking transfers between your own accounts; categories.
- SEB balance checks (the current export has no balance column; pending a
  sample of another export).

## Decisions

### 1. Schema (migration `0002`)

```
accounts            id, bank CHECK(in supported list), iban UNIQUE, currency,
                    display_name, opened_on date, opening_balance_minor_units bigint,
                    created_at
account_members     account_id FK, user_id text, role CHECK(owner|viewer),
                    created_at, PK(account_id, user_id)
statement_files     id, account_id FK (upload-selected account), uploaded_by,
                    bank, format_version, sha256, s3_key, status CHECK(approved|rejected),
                    rejection_reasons jsonb, warnings jsonb,
                    period_from date NULL, period_to date NULL, processed_at
                    UNIQUE INDEX (account_id, sha256) WHERE status = 'approved'
raw_rows            id, file_id FK, account_id FK (resolved per row), row_number,
                    bank, format_version, bank_transaction_id NULL, payload jsonb,
                    UNIQUE(file_id, row_number)
transactions        id, account_id FK, posted_date, amount_minor_units, currency,
                    description, fee_minor_units DEFAULT 0, balance_after_minor_units NULL,
                    dedup_key, FX columns + existing CHECKs, created_at,
                    UNIQUE(account_id, dedup_key)
transaction_sources transaction_id FK, raw_row_id FK, PK(transaction_id, raw_row_id)
```

- Old tables are dropped and recreated (test data only; task 7.1 confirms with
  the user before deploying).
- **Why `account_id` on `raw_rows`:** an SEB file can span accounts, so a raw
  row's account is resolved per row, not taken from the file. It also lets
  every RLS policy in the next change be a single membership check on
  `account_id`.
- **Why the partial unique index on `statement_files`:** it closes the race
  where the same file is uploaded twice concurrently. The losing transaction
  hits the conflict and is recorded as a duplicate rejection, matching the
  pipeline spec's scenario.
- **The last-owner rule** ("an account keeps at least one owner") is enforced
  in the membership domain functions under a row lock
  (`SELECT … FOR UPDATE` on the account's members). A deferred constraint
  trigger was considered but adds a trigger to every membership write for a
  rule with only two call sites.

### 2. Raw payload as `jsonb` of strings

- The payload maps header → original cell string. Duplicate headers are a
  validation rejection, because a JSON object can't hold two values for one
  key.
- Key order isn't preserved by `jsonb`; the original file in S3 remains the
  byte-exact source.
- Per-bank typed tables and a separate document store were considered and
  rejected (see ADR-0008, task 1.1): they need DDL per bank and format, can't
  have a real FK from `transaction_sources`, or lose the single-transaction
  import.

### 3. Validation pipeline in code, per (bank, format version)

`ingestion/src/lib/validation/` holds one module per bank. Each declares its
format versions:
- a header signature and a zod schema for the row's string cells;
- which rows affect the balance;
- whether a balance chain applies.

Processing order:
1. Decode; detect format from the header; check for duplicate headers.
2. Schema-validate every row, collecting all reasons (not just the first).
3. Parse into the parser output (raw payload + normalized rows).
4. Resolve accounts per row (owner membership).
5. Check the balance chain.
6. Check for a duplicate file (sha256).
7. Check overlap agreement against stored transactions: one query per
   resolved account for its existing `dedup_key`s in the file's key set.
8. Compute continuity warnings and the covered period.

Any hard reason → write only the rejected `statement_files` row. Otherwise
write everything in one transaction.

- zod is new to the repo. It is chosen over hand-written checks because each
  format version is just a schema, and its error paths map directly to
  row-number reasons.
- The chain check for Revolut walks `COMPLETED` rows in `Completed Date`
  order. The balance changes on completion, while `Started Date` is only the
  dedup and posting basis. monobank rows come newest-first and are walked in
  reverse.

### 4. Derivation and rebuild

- `deriveTransactions(rawRows)` is a pure function from parser output to
  transaction rows plus source links. The import calls it, and so does a
  maintenance handler `rebuildAccount(accountId)`. The rebuild deletes the
  account's `transaction_sources` and `transactions`, then re-derives them from
  `raw_rows` of approved files in `processed_at` order, all in one transaction.
- The rebuild is an internal operation invoked manually (`aws lambda invoke`).
  There is no user-facing surface yet.
- Writes use `INSERT … ON CONFLICT (account_id, dedup_key) DO NOTHING
  RETURNING id`, then a lookup of existing ids for conflicted keys, then a
  batched insert of `transaction_sources`.
- Batches are chunked to stay under Data API's 4 MiB per request. Raw payloads
  make rows larger than before, so the chunker counts serialized parameter
  bytes rather than rows.

### 5. Revolut specifics and assumptions

- `posted_date` and the dedup basis move from `Completed Date` to
  `Started Date`.
- **Assumption (pending the user's check of their Revolut account details):**
  one IBAN = one account = one currency. Under that assumption:
  - rows whose `Currency` differs from the account currency are a validation
    rejection;
  - rows whose `Product` is not `Current` (e.g. savings vaults) are kept
    raw-only.

  If the check shows Revolut uses one IBAN for several currencies, revisit
  this with a follow-up change. The raw rows are kept, so nothing is lost
  meanwhile.

### 6. Membership replaces `ownershipPredicate`

- `shared` exports `memberPredicate(alias, minRole)`. It returns
  `EXISTS (SELECT 1 FROM account_members m WHERE m.account_id = <alias>.account_id AND m.user_id = :sub [AND m.role = 'owner'])`.
- `shareGrants.ts` (`ownershipPredicate`, `assertCanMutateGrant`,
  `NotResourceOwnerError`) is removed. Its test intent (non-owner can't grant,
  revocation is immediate) moves to the membership tests.

## Risks / Trade-offs

- **Dropping tables loses whatever is live.** → Task 7.1 makes the user
  confirm the live data is disposable (or export it) before `infra:up`.
- **Hash-fallback dedup still can't merge identical-looking rows across files
  when they are ordered differently** (existing accepted limitation). → The
  overlap-agreement check now at least catches amount/date conflicts; the
  limitation stays documented.
- **Raw payload size grows Data API traffic.** → The byte-based chunker (decision
  4); statements are small for two users.
- **Revolut assumption may be wrong.** → Raw rows preserve everything, so
  correcting the model later is a rebuild, not data loss.
- **Two layers of truth (raw vs. derived) can drift if derivation changes.** →
  Raw is authoritative and the rebuild operation makes re-derivation routine.

## Migration Plan

1. `add-db-migrations` must be applied first.
2. Merge; `pnpm exec nx run infra:up` runs migration `0002` (drop + create)
   before the ingestion Lambdas update.
3. Re-create the real accounts (with opening balances) and re-import
   statements.
4. Rollback: forward-only. Revert the code and add a migration that restores
   the old shape if ever needed; test data only, so in practice re-run the
   imports.
