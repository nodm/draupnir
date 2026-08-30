import { parseCsv } from '../csv';
import {
  normalizeDescription,
  resolvePostedDate,
  toMinorUnits,
} from '../dedupKey';
import type { NormalizedRow } from './types';

// SEB exports one file with a title + header line repeated per account block
// (see __fixtures__/seb.csv) — not a single flat table. A data row is any
// line whose second field isn't the header marker and that has the full
// 18-column shape; title lines have exactly one field.
const HEADER_MARKER = 'DOK NR.';
// 18 real columns plus one trailing empty field from the line's closing `;`.
const DATA_ROW_FIELD_COUNT = 19;
// Matches only the real title shape (e.g. "SĄSKAITOS  (LT...) IŠRAŠAS (UŽ
// LAIKOTARPĮ: ...)") — a 2-field line alone isn't enough to recognize a
// title, since a truncated data row can also happen to have 2 fields.
const TITLE_LINE_PATTERN = /^SĄSKAITOS\s.*IŠRAŠAS/;

// Card purchases settled in a currency other than the account's embed the
// original amount/currency and the conversion fee as free text inside
// MOKĖJIMO PASKIRTIS — SEB exposes no dedicated column for this, unlike
// monobank's separate "Operation amount"/"Operation currency" fields. Example:
// "299.00 NOK(25.67 EUR + mokestis 0.68 EUR(2.65%))". Amounts here use `.` as
// the decimal separator, unlike the CSV's own `,`-separated numeric columns.
const FX_METADATA_PATTERN =
  /(-?\d+(?:\.\d+)?)\s+([A-Z]{3})\(-?\d+(?:\.\d+)?\s*EUR\s*\+\s*mokestis\s+(-?\d+(?:\.\d+)?)\s*EUR\((\d+(?:\.\d+)?)%\)\)/;

interface SebFxMetadata {
  originalCurrency: string;
  originalAmountMinorUnits: number;
  fxFeeMinorUnits: number;
  fxFeePercent: number;
}

function parseSebFxMetadata(
  paskirtis: string,
  amountSign: 1 | -1,
): SebFxMetadata | undefined {
  const match = FX_METADATA_PATTERN.exec(paskirtis);
  if (!match) {
    return undefined;
  }
  const [, originalAmount, originalCurrency, feeAmount, feePercent] = match;

  return {
    originalCurrency: originalCurrency as string,
    originalAmountMinorUnits: toMinorUnits(
      amountSign * parseFloat(originalAmount as string),
    ),
    fxFeeMinorUnits: toMinorUnits(parseFloat(feeAmount as string)),
    fxFeePercent: parseFloat(feePercent as string),
  };
}

function parseSebDate(value: string): Date {
  return new Date(`${value.trim()}T12:00:00Z`);
}

function parseSebAmountSign(debitCredit: string): 1 | -1 {
  const marker = debitCredit.trim().toUpperCase();
  if (marker === 'D') return -1;
  if (marker === 'C') return 1;
  throw new Error(`Unrecognized DEBETAS/KREDITAS marker: ${debitCredit}`);
}

function parseSebAmountMinorUnits(sumaField: string, amountSign: 1 | -1): number {
  const magnitude = parseFloat(sumaField.trim().replace(',', '.'));
  return toMinorUnits(amountSign * magnitude);
}

// Only takes `fileContents`: SEB rows carry their own account IBAN, so the
// `uploadAccountIban` second parameter from the shared `StatementParser`
// signature (which the dispatch map still calls with two arguments) is
// unused here — TS structurally allows a shorter-arity implementation.
export function parseStatement(fileContents: string): NormalizedRow[] {
  const lines = parseCsv(fileContents, ';');
  const rows: NormalizedRow[] = [];

  for (const fields of lines) {
    // Title lines (one text field matching the real title shape + the
    // trailing empty field from the line's closing `;`) and header lines
    // are recognized and skipped. Anything else with the wrong field count
    // is malformed — fail the whole file rather than silently dropping it.
    const isTitleLine =
      fields.length === 2 && TITLE_LINE_PATTERN.test(fields[0] ?? '');
    const isHeaderLine =
      fields.length === DATA_ROW_FIELD_COUNT && fields[0] === HEADER_MARKER;
    if (isTitleLine || isHeaderLine) {
      continue;
    }
    if (fields.length !== DATA_ROW_FIELD_COUNT) {
      throw new Error(
        `Malformed SEB row: expected ${DATA_ROW_FIELD_COUNT} fields, got ${fields.length}`,
      );
    }

    const data = fields[1] as string;
    const valiuta = fields[2] as string;
    const suma = fields[3] as string;
    const paskirtis = fields[9] as string;
    const transakcijosKodas = fields[10] as string;
    const debetasKreditas = fields[14] as string;
    const saskaitosNr = fields[16] as string;

    if (transakcijosKodas.trim().length === 0) {
      // dedup_key is derived solely from this field (bank-statement-parsers
      // spec) — an empty value would make multiple malformed rows collide
      // on `seb:` and silently lose all but one, instead of failing the file.
      throw new Error('Malformed SEB row: empty TRANSAKCIJOS KODAS');
    }

    const amountSign = parseSebAmountSign(debetasKreditas);
    const fxMetadata = parseSebFxMetadata(paskirtis, amountSign);

    rows.push({
      iban: saskaitosNr.trim(),
      postedDate: resolvePostedDate(parseSebDate(data)),
      amountMinorUnits: parseSebAmountMinorUnits(suma, amountSign),
      currency: valiuta.trim(),
      description: normalizeDescription(paskirtis),
      dedupKey: `seb:${transakcijosKodas.trim()}`,
      ...fxMetadata,
    });
  }

  return rows;
}
