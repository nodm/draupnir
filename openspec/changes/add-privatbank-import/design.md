## Context

Banks plug in at five points: `BANKS` (shared) + the DB CHECK, a parser
(`parsers/<bank>.ts`: `parseStatement` + payload-only `normalizeRows` used by rebuild),
a `FormatVersion` in `validation/formats.ts`, the `PARSERS`/`DELIMITERS`/`readTable`
maps in `validateStatement.ts`, and `NORMALIZERS` in `derive.ts`. Same shape as
`add-swedbank-import`; PrivatBank is closest to monobank (per-row balance, no id, FX).
See proposal.md for motivation.

Sample facts (`-temp-/privat/*.csv`; XLSX siblings ignored):
- UTF-8, CRLF, `;`, no quoting, `,` decimal, no BOM seen. Line 1 title
  `Історія операцій за період 05.11.2021 - 05.11.2026;;;;;;;;;` (10 fields), line 2 header
  (10 names), rest data. 178 UAH rows, 18 EUR rows.
- Newest first. Balance after each row chains exactly, incl. 6 pairs of same-second rows
  (file order is reverse-chronological within them, verified by balance).
- Card col: UAH file has `…2167` (≤ 2024-04) and `…5889` (≥ 2024-05) — reissue, one
  continuous balance chain. EUR file: `…0647`.
- `Сума в валюті картки` signed, in card currency; `Сума в валюті транзакції` is a
  magnitude (3 PLN rows on UAH card: −4404,91 UAH vs 395,12 PLN; also 1312/150 variants
  where currency equals card currency but amount differs — see risks).
- Category empty on ~4 rows (card top-ups). No bank transaction id, no fee column.
- A refund shows as `+200` with the same description as the purchase.

## Goals / Non-Goals

**Goals:**
- Import both samples end to end with balance chain verified and continuity via
  existing balance-based logic (same as monobank).
- Reuse monobank patterns; minimal new validation code.

**Non-Goals:**
- XLSX, other layouts/languages, IBAN/card-based account auto-pick, using the title
  period as a declared period, categories (kept raw only).

## Decisions

1. **Bank id `privatbank`, display `PrivatBank`.** Latin like `Swedbank`; id stable
   and ASCII. *Alt:* `privat24`/Cyrillic name — worse key, no gain.

2. **Own table reader (`readPrivatbankTable`)** that requires line 1 to match the title
   shape, then reads header + rows with `;` via `parseCsv`. Row numbers count data rows
   only. `validateStatementFile.readTable` gets a `privatbank` branch (like `seb`,
   `swedbank`). *Alt:* loosen `readSimpleTable` to skip any title — would hide a
   missing/changed header for other banks.

3. **Upload-selected account; card ignored** (kept raw). Reissue changes the mask, so
   it cannot identify an account; the user picks via the existing buttons. Cross-account
   mixups are caught by the balance chain/continuity and currency check.
   *Alt:* map card→account — brittle across reissues.

4. **Card currency throughout.** `normalizeRows` uses cols 5/6/9 for amount/currency/
   balance; original amount only when col 8 ≠ col 6, signed like the card amount.
   Mirrors monobank. Currency = col 6 of the first row; validation rejects rows whose
   col 6 or col 10 differs.

5. **Dedup = hash fallback incl. time of day** (`computeHashDedupKeys`, occurrence
   index). `postedDate` stays the date; the `HH:MM:SS` is added to the hash input via a
   new optional field on `HashDedupKeyInput`, so other banks' keys are unchanged (prod
   has data). Identical rows at different seconds are distinct by time; the occurrence
   index only ranks identical-second rows, stable across mid-day-cut overlapping exports.
   *Alt:* date-only like monobank — index shifts if exports overlap mid-day.

6. **Order:** `occurredAt` from `DD.MM.YYYY HH:MM:SS` (existing `isoFromDotted`, UTC
   reading), `sourceSeq = reverseFileOrder`. Same as monobank; balance chain verifies it.

7. **No declared period.** Title period end is the export date (2026-11-05 vs last tx
   2026-10-26), so it would over-claim coverage; coverage comes from rows, as for
   monobank. Title is validated for shape only.

8. **Migration `0021`** (next after 0020; confirm number): drop + re-add
   `accounts_bank_check` with `'privatbank'`. No data touched.

9. **Bot:** only `BANK_NAMES` entry; upload stays on buttons.

## Risks / Trade-offs

- [Same-second rows ordered by file order] → balance chain rejects a wrong order; fixture
  covers it.
- [Hash key unstable if bank edits description or shifts displayed time (no tz)] → same class as monobank/Revolut; low likelihood.
- [`Сума в валюті транзакції` differs from card amount with equal currency (1312 vs
  −1318,67 UAH; 150 vs −155) — likely fees included in card amount] → we only trust card
  columns; no original amount when currencies match. Verify in fixtures; fee stays 0.
- [Timestamps have no timezone; read as UTC] → only relative order matters (as monobank).
- [Only the Ukrainian header seen] → format versioned; new layouts = new entry.
- [CSV is a manual conversion of the bank's XLSX] → out of scope; user supplies CSV.
  Mismatch of number formatting from conversion tools → validation rejects, not guesses.
- [CHECK constraint name assumption] → migration test on pglite after prior migrations.

## Migration Plan

Deploy migration (additive, online), then ingestion + bot. Rollback: redeploy previous
code; wider CHECK is harmless. Then `/newaccount` (bank PrivatBank, UAH/EUR, opening
balance matching the oldest file) and upload files in date order.
