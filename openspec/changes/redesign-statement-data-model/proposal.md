## Why

Today's schema keeps only the fields the parsers normalize, so everything else a
bank exports (balance after each row, fees, MCC, counterparty details, the
bank's own state/product columns) is thrown away and can never be re-derived.
Accounts have exactly one owner, so a joint account can't be shared properly,
and `UNIQUE(iban)` / `UNIQUE(dedup_key)` apply across all users — which, once
RLS lands, both leaks other users' data and can silently drop a transaction
that collides with a row the uploader cannot see. There is also no record of
which files were imported, approved, or rejected, and no check that an import
is complete.

Depends on `add-db-migrations` (schema ships as migration `0002`).

## What Changes

- **BREAKING** — accounts and access:
  - `accounts` no longer carries `owner_user_id`. A new `account_members`
    table links users to accounts with a role (`owner` | `viewer`); every
    account always has at least one owner.
  - `accounts` gains `opened_on` and `opening_balance_minor_units`, entered
    once at creation.
  - `share_grants` is removed: account membership replaces it. Category
    sharing returns when categories exist.
- **BREAKING** — the statement storage model becomes three layers:
  - The original CSV stays in S3, unchanged.
  - `statement_files` records every import: uploader, account, bank, format
    version, SHA-256, status (`approved` | `rejected`), rejection reasons,
    warnings, and covered period.
  - `raw_rows` stores every row of an approved file as `jsonb`, with values
    exactly as the bank wrote them (strings), plus bank, format version, row
    number, and the bank's transaction id where one exists.
  - `transactions` becomes the common, derived table. It no longer carries
    `owner_user_id` (visibility comes from account membership), gains
    `fee_minor_units` and `balance_after_minor_units`, and enforces
    `UNIQUE (account_id, dedup_key)` instead of global uniqueness.
  - `transaction_sources` links each transaction to every raw row it came
    from, so overlapping statements produce one transaction with several
    sources.
- **Validation** per (bank, format version) approves or rejects the whole file:
  - Hard rejects:
    - malformed or unknown format, including duplicate column headers;
    - a broken balance chain inside the file (Revolut, monobank);
    - disagreement with transactions already stored for the same period;
    - the same file already imported for that account.
  - Warnings only: the file doesn't connect to stored history or the
    opening balance. These are reported as coverage gaps per account.
- A rejected file is recorded with its reasons and does not go to the retry
  queue or the dead-letter queue. Only unexpected errors keep the existing
  retry → DLQ path.
- Revolut: only `COMPLETED` rows enter `transactions`. `PENDING` / `REVERTED`
  / `DECLINED` rows are kept in `raw_rows` only. Dedup uses `Started Date`.
- `transactions` can be rebuilt from `raw_rows` for an account without
  re-uploading anything.
- Upload and per-row account resolution require the uploader to be an `owner`
  member of the account.
- Live data: the current tables hold test data only. Migration `0002` drops
  them and creates the new schema (confirmed in tasks before deploying).

## Capabilities

### New Capabilities
- `statement-raw-storage`: the file and raw-row layers. Every import is
  recorded, rows are stored losslessly and versioned by format, duplicate
  uploads are detected, and the common table can be rebuilt.
- `statement-validation`: per-bank, per-format validation rules, the balance
  check tiers (hard reject vs. warning), and per-account coverage and gap
  reporting.

### Modified Capabilities
- `transactions-schema`: accounts without `owner_user_id`, with opening
  balance; transactions without `owner_user_id`, with fee and balance-after;
  dedup scoped per account; link to raw sources.
- `row-level-authorization`: ownership and sharing move from per-row owner
  plus `share_grants` to account membership with `owner` / `viewer` roles.
- `account-management`: creating an account makes the caller its owner
  member and records the opening balance; per-row account resolution uses
  owner membership.
- `statement-ingestion-pipeline`: one database transaction stores the file
  record, raw rows, and derived transactions; validation rejections are
  recorded, not retried.
- `bank-statement-parsers`: parsers emit the raw string payload and format
  version alongside normalized rows; Revolut state filtering and the
  `Started Date` dedup basis; balance-after extraction.
- `statement-csv-upload`: the upload URL requires `owner` membership of the
  selected account.

## Impact

- `shared/src/lib/`:
  - migration `0002`;
  - new domain types for files, raw rows, and membership;
  - `ownershipPredicate` / `assertCanMutateGrant` are replaced by
    membership helpers.
- `ingestion/src/lib/`:
  - `processStatementFile.ts` is rewritten (validate → store → derive in
    one transaction);
  - `parsers/*` emit raw payload and format version, with new validation
    modules per bank and format;
  - `accounts.ts` creates the owner membership;
  - `presignedUpload.ts` checks owner role;
  - `dedupKey.ts` is adjusted (Revolut `Started Date`).
- New dependency: `zod` (schema validation per bank and format).
- Live cluster: existing test rows in `accounts` / `transactions` /
  `share_grants` are dropped.
- Follow-ups that build on this:
  - `add-row-level-security` (policies on these tables);
  - `add-telegram-bot` (upload and account commands);
  - `add-mcp-data-tools` (queries).
- Not in scope:
  - linking transfers between your own accounts;
  - Revolut savings / multi-currency handling beyond the assumption in
    design.md;
  - SEB balance checks (pending a sample export that includes balances).
