## 1. Bank registration

- [x] 1.1 Add `swedbank` to `BANKS` and migration `0020` widening `accounts.bank` CHECK; migration test (pglite): swedbank insert OK, unknown bank rejected, pre-existing seb/revolut/monobank rows intact
- [x] 1.2 Add `swedbank: 'Swedbank'` to bot `BANK_NAMES`; format test shows it in `/accounts` and `/newaccount` keyboard (`pnpm nx test bot`)

## 2. Fixtures

- [x] 2.1 Anonymize two fixtures from `-temp-/swedbank` (current, savings) in `ingestion/src/lib/parsers/__fixtures__/`: card purchase, transfer, interest, 10/82/86(/900) rows, short row, a `20` row with empty record number, CRLF; verify no real names/IBANs/card numbers remain (grep)

## 3. Parser

- [x] 3.1 Add `swedbank-v1` to `formats.ts` (header match incl. trailing empty, zod row schema, `FORMATS`); unit tests for header match/mismatch and cell errors
- [x] 3.2 Add `parsers/swedbank.ts`: `readSwedbankTable`, `normalizeRows` (type dispatch, D/K sign, `swedbank:` key with hash fallback, order), `parseStatement`; parser spec against fixtures covers all bank-statement-parsers scenarios
- [x] 3.3 Register in `PARSERS`, `DELIMITERS`, `readTable` (validateStatement) and `NORMALIZERS` (derive); validateStatement spec: fixture approved, duplicate-header not raised, unknown row type rejected

## 4. Balance reconciliation and continuity

- [x] 4.1 Extend `ParsedStatement` with declared opening/closing balances; Swedbank parser fills them and `declaredPeriods`; `checkBalanceChain` reports opening+Σtx≠closing and turnover mismatches and returns balances; tests: pass, dropped row, turnover mismatch, missing closing
- [x] 4.2 Test continuity through `processStatementFile` (pglite): import 2022-23 → 2024-25 → 26 fixtures in order OK; skipping a year rejected with gap reason; account balance and running balances correct; rebuild reproduces them

## 5. Bot upload

- [x] 5.1 Add `swedbankIbans` (+ unit tests: current/savings fixture → one IBAN, SEB/Revolut file → [], multi-IBAN) and use it in `handleUpload`; upload spec: auto-attach for one matching Swedbank account, buttons for none/ambiguous/other bank

## 6. Docs and wrap-up

- [x] 6.1 Update `docs/data-model.md` supported banks/format notes
- [x] 6.2 Run `pnpm nx run-many -t lint test build` and `tsc --noEmit`; all green
