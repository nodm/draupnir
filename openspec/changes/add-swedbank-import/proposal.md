## Why

Swedbank (Lithuania) accounts — a current account and a savings/deposit account — are
not importable: only SEB, Revolut and monobank are supported. Real exports exist
(`-temp-/swedbank/statement-*.csv`, 2022–2026), so the format is known.

## What Changes

- Add `swedbank` as a supported bank: `BANKS`, DB `accounts.bank` CHECK constraint
  (additive migration), bot display name. `/newaccount` offers it automatically.
- New Swedbank parser + format version `swedbank-v1` for the Lithuanian-language CSV
  export (comma-delimited, quoted, one account per file, IBAN on every row).
- Only transaction rows (row type `20`) enter `transactions`. Opening (`10`), turnover
  (`82`), closing (`86`) and accrued-interest (`900`) rows are kept raw-only.
- Dedup key from the bank's per-row record number (`Įrašo Nr.`), namespaced `swedbank:`;
  hash fallback (with occurrence index) for a transaction row lacking one.
- Files carry opening and closing balance but no per-row balance. Validation checks
  opening + transactions = closing, and the turnover rows against the transactions;
  the opening/closing balances feed continuity between files (like Revolut/monobank).
- Anonymized fixtures from the real samples (current + savings account).

- Bot auto-attaches a Swedbank file to the owned Swedbank account whose IBAN the file
  names (like SEB); asks with buttons when that is not exactly one account.

Out of scope: other export languages/layouts, PDF/XLSX exports.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `bank-statement-parsers`: add Swedbank parser (row kinds, sign, dedup key, row-account
  IBAN, fixture requirement coverage).
- `statement-validation`: add Swedbank format checks and the file-level
  opening/turnover/closing reconciliation; balance-based continuity applies to formats
  that state opening/closing balances, not only per-row balances.
- `transactions-schema`: supported-bank list gains `swedbank`.
- `telegram-statement-upload`: Swedbank files auto-select their account by IBAN.

## Impact

- `shared`: `BANKS`, new migration (CHECK constraint on `accounts.bank`).
- `ingestion`: `parsers/swedbank.ts`, `validation/formats.ts`, `validation/balanceChain.ts`,
  `validation/validateStatement.ts`, `derive.ts`, `parsers/types.ts`, fixtures + specs.
- `bot`: `accounts/format.ts` bank name; `upload/` IBAN detection for Swedbank files.
- `docs/data-model.md`: supported banks / format notes.
- Prod has real data: migration only widens the CHECK; no data rewrite.
