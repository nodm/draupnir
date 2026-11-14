## Context

Existing banks plug in at five points: `BANKS` (shared) + the DB CHECK, a parser
(`parsers/<bank>.ts`, exporting `parseStatement` and a payload-only `normalizeRows` used
by rebuild), a `FormatVersion` in `validation/formats.ts`, the `PARSERS`/`DELIMITERS`
maps in `validateStatement.ts`, and `NORMALIZERS` in `derive.ts`. See proposal.md for
motivation.

Swedbank sample facts (`-temp-/swedbank/*.csv`, 6 files, 2 accounts, 115 transactions):
- UTF-8, CRLF, `,` delimiter, every cell quoted, `.` decimal, ISO dates.
- Header: 16 names + trailing empty field. Column 2 has an empty name → two empty
  header names, which the generic duplicate-header check would reject.
- Rows are ragged: type `20` rows have 14 fields, summary rows 13 (trailing empties
  dropped), both shorter than the 17-field header → generic `cells.length !==
  headers.length` check would reject.
- Column 2 is a row type: `10` opening, `20` transaction, `82` turnover (one per D/K),
  `86` closing, `900` accrued interest (savings, not yet posted).
- Column `D/K`: `K` credit, `D` debit. `Įrašo Nr.` (16 digits) is unique for all 115
  transactions across both accounts, including the own-account transfers.
- Opening/closing balances chain across the yearly files (1006.58 → 1006.58,
  89.73 → 89.73, 19310.02 → 19310.02). Rows are in ascending date order.

## Goals / Non-Goals

**Goals:**
- Import both sample account kinds end to end with balance continuity across files.
- Catch a dropped/duplicated row via opening + Σtx = closing and turnover checks.

**Non-Goals:**
- Auto-pick for other banks (Revolut/monobank have no account in the file).
- Other languages/layouts, per-row balances, posting accrued interest.

## Decisions

1. **Own table reader (`readSwedbankTable`) rather than loosening `readSimpleTable`.**
   It parses with `,`, drops the trailing empty header, pads short records to header
   width, and leaves the unnamed column keyed `""` in the raw payload (original headers
   preserved, per the raw-payload requirement). `validateStatementFile.readTable` gets a
   `swedbank` branch like `seb`. The generic duplicate-header check then sees one `""`.
   *Alt:* make `readSimpleTable` lenient for all banks — weakens Revolut/monobank checks.

2. **Row-type dispatch; only `20` normalizes.** Mirrors Revolut's raw-only rows.
   Unknown row types fail the file rather than being skipped: a silently dropped type
   could be real money. *Alt:* ignore unknown — risks hidden transactions.

3. **Dedup key `swedbank:<Įrašo Nr.>`**, like SEB's provider id. Verified unique in all
   samples, but the column is optional in the format, so a `20` row without one uses the
   existing hash fallback (`computeHashDedupKeys`, occurrence index over fallback rows
   only; hex digest cannot collide with the `swedbank:` prefix). *Alt:* reject such rows
   — blocks the import; hash-only — breaks on description edits.

4. **Balances from the file, not per row.** Add `declaredBalances` (iban → opening,
   closing) and reuse `declaredPeriods` (opening-row date → closing-row date) on
   `ParsedStatement`. `checkBalanceChain` returns them in `balancesByIban` when no
   per-row chain exists, and for Swedbank also emits reasons for
   opening + Σtx ≠ closing and turnover mismatch. `processStatementFile` already builds
   segments from `balancesByIban` + `declaredPeriods`, and `computeCoverage`/
   `continuityReasons` already use `hasBalances`, so continuity needs no change there
   (verify with a test). Running balance stays computed (account-balances), as for SEB.

5. **Sign/amount:** `D/K` → ±1, amount `parseFloat` of dot-decimal via `toMinorUnits`;
   `occurredAt = isoFromDateOnly`, `sourceSeq = fileOrder` (files are date-ascending).

6. **Row IBAN is authoritative** (like SEB); every row's currency is checked against its
   account by existing logic.

7. **Bot auto-pick**: new `swedbankIbans(csvText)` in `bot/src/lib/upload/` (mirror of
   `sebHeader.ts`; bot cannot import ingestion): detects the Swedbank header line, returns
   distinct IBANs from the first column of the data lines. `handleUpload` auto-attaches
   when exactly one owned account has `bank` swedbank/seb and an IBAN in the file's set;
   anything else → buttons (unchanged). Parsing is by line/regex, not full CSV.

8. **Migration `0020`**: `ALTER TABLE accounts DROP CONSTRAINT accounts_bank_check`, then
   re-add with `'swedbank'`. Inline unnamed CHECK from 0002 → Postgres default name
   `accounts_bank_check`; confirm in pglite test. No data touched.

## Risks / Trade-offs

- [Record number reuse across exports/accounts] → fixture test asserts uniqueness across
  both sample accounts; a colliding id with different data is a rejected file via the
  overlap check, not silent loss.
- [Hash-fallback keys change if a description is edited by the bank] → same limitation
  as Revolut/monobank; only affects rows lacking a record number.
- [Declared period] opening-row date → closing-row date (e.g. 2026-01-01..2026-11-14):
  accepted because the balance is stated as of those dates; the start can precede the
  account's `opened_on` harmlessly.
- [Export period end = export date (2026-11-14), later than last transaction] →
  declared period ends at export date; a later file opening at the earlier closing is
  still continuous. Overlap logic already handles differing boundary balances.
- [Only Lithuanian headers seen] → format versioned; other layouts = new entry.
- [`900` accrued interest ignored] → raw-only, not in balance; closing balance in the
  sample excludes it (22348.83 = 19310.02 + 3038.81).
- [CHECK constraint name assumption] → migration test on pglite after 0002–0019.

## Migration Plan

Deploy migration (additive, online), then ingestion + bot. Rollback: redeploy previous
code; the wider CHECK is harmless. Then the user creates the accounts via `/newaccount` and uploads the files in date
order (a file's opening balance must match its account's opening balance).
