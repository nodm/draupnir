## Why

Draupnir has auth/ownership (`add-auth-authz-layer`) but no way to get real transaction
data into the system — `accounts` and `transactions` don't exist yet, and there is no
ingestion pipeline. This change builds the first end-to-end path: a user uploads a bank
CSV, it lands in the database as deduplicated transaction rows. Per the user's explicit
prioritization, this ships before `mcp`'s base API/authorizer work.

## What Changes

- Define the `accounts` and `transactions` schema (columns, `owner_user_id`, `iban`
  (unique) on `accounts`, `dedup_key` with a `UNIQUE` constraint + index on
  `transactions`) — referenced conceptually by ADR-0003/ADR-0004 but never specified
  until now.
- Add a presigned-upload endpoint on `ingestion`'s REST API: authenticated caller gets a
  presigned S3 PUT URL scoped to `uploads/{sub}/{accountId}/{uuid}.csv`. `sub` taken only
  from the Cognito authorizer claim; `accountId` must name an existing `accounts` row
  owned by that caller (bank is derived from the account, not a separate request field —
  confirmed against a real SEB sample that one export file can span multiple accounts, so
  the upload-selected account is a default, not a guarantee — see below).
- Provision Pulumi resources: `uploads` S3 bucket, S3 Event Notification → one standard
  SQS queue, DLQ with `maxReceiveCount`, SQS-triggered ingestion Lambda (batch size 1).
- Implement one ingestion Lambda that reads the S3 object, resolves the upload-selected
  account and its bank from the `accountId` segment in the S3 key, dispatches to that
  bank's parser, normalizes rows to a common shape (each row carrying its own resolved
  IBAN), computes a per-row `dedup_key`, resolves each row's target account by
  `owner_user_id + iban` (may differ per row for a multi-account SEB file), and writes
  all rows for the file in one Data API transaction (`BeginTransaction` →
  `INSERT ... ON CONFLICT (dedup_key) DO NOTHING` → `CommitTransaction`) — if any row's
  IBAN has no matching account, the whole file fails, per ADR-0003/ADR-0004.
- Implement three bank parsers: SEB (reads each row's own IBAN; dedup key from the
  per-row provider transaction ID, namespaced `seb:{id}` — confirmed to be a distinct
  column from the shared document reference that repeats across both legs of an
  internal transfer), Revolut and monobank (every row uses the upload-selected account's
  IBAN; hash-fallback dedup key: `account_id + posted_date + amount_minor_units +
  currency + normalized_description + occurrence_index` — confirmed neither export
  carries a usable per-row ID), each with a test fixture built from an anonymized sample
  statement.
- Add a minimal `POST /accounts` endpoint (create-only, no update/delete/list) accepting
  `{ bank, iban, currency, displayName }`, so a user can create the `accounts` row an
  upload needs before uploading against it — ingestion does not auto-create accounts.
- Capture FX metadata for SEB foreign-currency card purchases: the original
  currency/amount and conversion fee (amount + percent), which SEB only exposes as
  free text inside the payment-purpose field. Four new nullable `transactions`
  columns (`original_currency`, `original_amount_minor_units`, `fx_fee_minor_units`,
  `fx_fee_percent`) exist generically on the schema; only SEB's parser populates them
  — Revolut/monobank leave them null.
- **Out of scope**: the SES email ingestion channel (ADR-0004's second entry point) —
  deferred to a follow-up change; it needs domain/MX verification and SES receiving-region
  availability is unconfirmed. The shared skeleton (S3 → SQS → Lambda → parser → dedup)
  is built so that channel can plug in later without restructuring this one.

## Capabilities

### New Capabilities
- `transactions-schema`: defines the `accounts` and `transactions` tables, ownership
  columns, and the `dedup_key` unique constraint that ingestion writes depend on.
- `statement-csv-upload`: the presigned-upload endpoint and its S3 key scoping/authorization.
- `account-management`: the create-only `POST /accounts` endpoint an upload's account
  resolution depends on.
- `statement-ingestion-pipeline`: the S3→SQS→Lambda plumbing, per-file transactional write,
  and DLQ/retry behavior — bank-agnostic.
- `bank-statement-parsers`: the three bank-specific parsers (SEB, Revolut, monobank),
  their normalization and dedup-key rules.

### Modified Capabilities
(none — `row-level-authorization`'s ownership pattern is reused as-is, not changed)

## Impact

- **New Pulumi resources** (`infra`): `uploads` S3 bucket + event notification, standard
  SQS queue + DLQ + redrive policy, ingestion Lambda's SQS event-source mapping, IAM policy
  additions (S3 read on the bucket, SQS consume, existing Data API/Secrets Manager grants
  extended to the new tables).
- **`ingestion` project**: new presigned-URL handler alongside existing `whoami`; new
  SQS-triggered handler entrypoint; new `lib/parsers/{seb,revolut,monobank}.ts` modules;
  new `lib/dedupKey.ts`.
- **`shared` project**: new `accounts`/`transactions` DDL alongside existing
  `SHARE_GRANTS_TABLE_DDL`; `ownershipPredicate` reused as-is for future read endpoints
  against these tables (not exercised by the write-only ingestion path itself).
- **No changes** to `mcp`, `user-authentication`, or `row-level-authorization` specs.
