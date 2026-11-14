## 1. Bank registration

- [x] 1.1 Add `privatbank` to `BANKS` and migration (next number after `0020`) widening `accounts.bank` CHECK; pglite migration test: privatbank insert OK, unknown bank rejected, seb/revolut/monobank/swedbank rows intact
- [x] 1.2 Add `privatbank: 'PrivatBank'` to bot `BANK_NAMES`; format test shows it in `/accounts` and `/newaccount` keyboard (`pnpm nx test bot`)

## 2. Fixtures

- [x] 2.1 Anonymize `privatbank-uah.csv` and `privatbank-eur.csv` from `-temp-/privat` into `ingestion/src/lib/parsers/__fixtures__/`: title line, two card masks (reissue), PLN row, same-timestamp pair, refund, own-card transfer, empty category, CRLF; recompute nothing — keep balances chaining; grep confirms no real names/card numbers/phone numbers/payment IDs remain

## 3. Parser

- [x] 3.0 Add optional time-of-day to `HashDedupKeyInput`/`computeHashDedupKeys`; verify existing Revolut/monobank/Swedbank keys are unchanged (existing specs pass) and a new test shows time changes the key

- [x] 3.1 Add `privatbank-v1` to `formats.ts` (title-line match, header match, zod row schema, `FORMATS`); unit tests for title/header match and mismatch, bad amount, empty category, mixed currency
- [x] 3.2 Add `parsers/privatbank.ts`: `readPrivatbankTable`, `normalizeRows` (card-currency amount, original amount, hash dedup, `reverseFileOrder`, balance), `parseStatement`; parser spec against fixtures covers all bank-statement-parsers scenarios
- [x] 3.3 Register in `PARSERS`, `DELIMITERS`, `readTable` (validateStatement) and `NORMALIZERS` (derive); validateStatement spec: both fixtures approved, missing title rejected, dropped row breaks chain, card reissue keeps chain

## 4. Continuity and rebuild

- [x] 4.1 pglite test via `processStatementFile`: import UAH fixture, then a later overlapping file OK; gap rejected; account balance and running balances correct; rebuild from `raw_rows` reproduces transactions

## 5. Docs and wrap-up

- [x] 5.1 Update `docs/data-model.md` supported banks/format notes
- [x] 5.2 Run `pnpm nx run-many -t lint test build` and `tsc --noEmit`; all green
