## Why

ПриватБанк (PrivatBank, Ukraine) card accounts — one UAH, one EUR — are not
importable: only SEB, Revolut, monobank and Swedbank are supported. Real exports exist
(`-temp-/privat/*.csv`: UAH 2021–2026, EUR 2024–2026), so the format is known.

## What Changes

- Add `privatbank` as a supported bank: `BANKS`, DB `accounts.bank` CHECK constraint
  (additive migration), bot display name `PrivatBank`. `/newaccount` offers it
  automatically.
- New PrivatBank parser + format version `privatbank-v1` for the Ukrainian-language CSV
  export: `;`-delimited, title line (`Історія операцій за період …`) then header, newest
  row first, `,` decimal, `DD.MM.YYYY HH:MM:SS` timestamps.
- Like monobank: no account id in the file (card mask only) → rows attach to the
  upload-selected account; per-row balance (`Залишок на кінець періоду`) enables the
  balance chain; no bank transaction id → hash-fallback dedup key with occurrence index.
- Amount/currency/balance are taken in the card currency; when the transaction currency
  differs (e.g. PLN on a UAH card) it is kept as the original amount.
- A file may mix several cards of one account (reissued card: `…2167` → `…5889` in the
  UAH sample); the balance chain must stay unbroken across them.
- Anonymized fixtures from the real samples (UAH with FX + same-timestamp rows, EUR).

Out of scope: XLSX exports (bot accepts CSV only), other export languages/layouts,
auto-picking the account (no IBAN in file → bot keeps asking with buttons), the file's
title-line period as a declared period.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `bank-statement-parsers`: add PrivatBank parser (upload-selected account, card
  currency amounts, FX original amount, hash-fallback key, newest-first order,
  fixture coverage).
- `statement-validation`: add PrivatBank format checks (title + header, row cells,
  single card currency) and balance-chain coverage.
- `transactions-schema`: supported-bank list gains `privatbank`.

## Impact

- `shared`: `BANKS`, new migration (CHECK constraint on `accounts.bank`).
- `ingestion`: `parsers/privatbank.ts`, `validation/formats.ts`,
  `validation/validateStatement.ts`, `derive.ts`, `parsers/order.ts`, fixtures + specs.
- `bot`: `accounts/format.ts` bank name. No upload-flow change.
- `docs/data-model.md`: supported banks / format notes.
- Prod has real data: migration only widens the CHECK; no data rewrite.
