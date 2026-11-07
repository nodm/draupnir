import { parseCsv } from '../csv';
import {
  normalizeDescription,
  resolvePostedDate,
  toMinorUnits,
} from '../dedupKey';
import { detectFormat, isRealIsoDatePart } from '../validation/formats';
import type { ValidationReason } from '../validation/types';
import { fileOrder, isoFromDateOnly } from './order';
import {
  duplicateHeaders,
  toPayload,
  UnrecognizedFormatError,
  type Table,
} from './table';
import type {
  DeclaredPeriod,
  NormalizedRow,
  ParsedRow,
  ParsedStatement,
  RawInputRow,
  RowNormalizer,
} from './types';

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
// The same title also states the period the export covers for that account.
const TITLE_PERIOD_PATTERN =
  /^SĄSKAITOS\s+\(([A-Z0-9]+)\)\s+IŠRAŠAS\s+\(UŽ LAIKOTARPĮ:\s*(\d{4}-\d{2}-\d{2})-(\d{4}-\d{2}-\d{2})\)/;

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
      originalCurrency as string,
    ),
    // The fee is always stated in EUR in the purpose text (see the pattern
    // above: "mokestis {feeAmount} EUR"), regardless of originalCurrency.
    fxFeeMinorUnits: toMinorUnits(parseFloat(feeAmount as string), 'EUR'),
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

function parseSebAmountMinorUnits(
  sumaField: string,
  amountSign: 1 | -1,
  currency: string,
): number {
  const magnitude = parseFloat(sumaField.trim().replace(',', '.'));
  return toMinorUnits(amountSign * magnitude, currency);
}

export interface SebTable extends Table {
  declaredPeriods: DeclaredPeriod[];
  // Lines that are neither title, header, nor a full-width data row. Reported
  // by validation; the parser treats any of them as fatal.
  malformed: ValidationReason[];
}

// Splits a SEB export into its header, data rows (trailing `;` field dropped),
// and the declared period of each account block.
export function readSebTable(fileContents: string): SebTable {
  const lines = parseCsv(fileContents.replace(/^\uFEFF/, ''), ';');
  let headers: string[] | undefined;
  const records: Table['records'] = [];
  const malformed: ValidationReason[] = [];
  let rowNumber = 0;

  // A title line states the period for the account block that follows it. The
  // period is attributed to the IBANs of that block's own rows (their
  // SĄSKAITOS NR), falling back to the title's IBAN for an empty block; a
  // second block for the same account widens its period.
  const periodByIban = new Map<string, DeclaredPeriod>();
  let block: { title: DeclaredPeriod; rowIbans: Set<string> } | undefined;
  const addPeriod = (iban: string, from: string, to: string) => {
    const known = periodByIban.get(iban);
    periodByIban.set(iban, {
      iban,
      from: known && known.from < from ? known.from : from,
      to: known && known.to > to ? known.to : to,
    });
  };
  const flushBlock = () => {
    if (!block) return;
    const ibans =
      block.rowIbans.size > 0 ? [...block.rowIbans] : [block.title.iban];
    for (const iban of ibans) addPeriod(iban, block.title.from, block.title.to);
    block = undefined;
  };

  for (const fields of lines) {
    // Title lines (one text field matching the real title shape + the
    // trailing empty field from the line's closing `;`) and header lines
    // are recognized and skipped. Anything else with the wrong field count
    // is malformed — fail the whole file rather than silently dropping it.
    const isTitleLine =
      fields.length === 2 && TITLE_LINE_PATTERN.test(fields[0] ?? '');
    const isHeaderLine =
      fields.length === DATA_ROW_FIELD_COUNT && fields[0] === HEADER_MARKER;
    if (isTitleLine) {
      flushBlock();
      const period = TITLE_PERIOD_PATTERN.exec(fields[0] as string);
      const invalidPeriod =
        period &&
        (!isRealIsoDatePart(period[2] as string) ||
          !isRealIsoDatePart(period[3] as string) ||
          (period[2] as string) > (period[3] as string));
      if (period && invalidPeriod) {
        // A bogus period would corrupt coverage and continuity, so the file is
        // rejected rather than the period being ignored or normalized.
        malformed.push({
          code: 'invalid-declared-period',
          message: `Invalid declared period ${period[2]} to ${period[3]} for ${period[1]}: not real dates, or start after end`,
        });
      } else if (period) {
        block = {
          title: {
            iban: period[1] as string,
            from: period[2] as string,
            to: period[3] as string,
          },
          rowIbans: new Set(),
        };
      }
      continue;
    }
    if (isHeaderLine) {
      headers ??= fields.slice(0, -1);
      continue;
    }

    rowNumber += 1;
    if (fields.length !== DATA_ROW_FIELD_COUNT) {
      malformed.push({
        code: 'malformed-row',
        row: rowNumber,
        message: `Malformed SEB row: expected ${DATA_ROW_FIELD_COUNT} fields, got ${fields.length}`,
      });
      continue;
    }
    records.push({ rowNumber, cells: fields.slice(0, -1) });
    block?.rowIbans.add((fields[16] as string).trim());
  }
  flushBlock();

  if (!headers) {
    throw new UnrecognizedFormatError('no SEB header line found');
  }
  return {
    headers,
    records,
    declaredPeriods: [...periodByIban.values()],
    malformed,
  };
}

// SEB rows carry their own account IBAN, so `accountIban` is unused.
export const normalizeRows: RowNormalizer = (rows) => {
  const out = new Map<number, NormalizedRow>();
  const sourceSeq = fileOrder(rows.length);
  for (const [index, { rowNumber, payload }] of rows.entries()) {
    const data = payload['DATA'] as string;
    const valiuta = payload['VALIUTA'] as string;
    const suma = payload['SUMA'] as string;
    const paskirtis = payload['MOKĖJIMO PASKIRTIS'] as string;
    const transakcijosKodas = payload['TRANSAKCIJOS KODAS'] as string;
    const debetasKreditas = payload['DEBETAS/KREDITAS'] as string;
    const saskaitosNr = payload['SĄSKAITOS NR'] as string;

    if (transakcijosKodas.trim().length === 0) {
      // dedup_key is derived solely from this field (bank-statement-parsers
      // spec) — an empty value would make multiple malformed rows collide
      // on `seb:` and silently lose all but one, instead of failing the file.
      throw new Error('Malformed SEB row: empty TRANSAKCIJOS KODAS');
    }

    const amountSign = parseSebAmountSign(debetasKreditas);
    out.set(rowNumber, {
      iban: saskaitosNr.trim(),
      postedDate: resolvePostedDate(parseSebDate(data)),
      amountMinorUnits: parseSebAmountMinorUnits(suma, amountSign, valiuta),
      currency: valiuta.trim(),
      description: normalizeDescription(paskirtis),
      dedupKey: `seb:${transakcijosKodas.trim()}`,
      occurredAt: isoFromDateOnly(data),
      sourceSeq: sourceSeq[index] as number,
      // The SEB export has no fee column; the FX fee lives in the fx_*
      // columns below.
      feeMinorUnits: 0,
      ...parseSebFxMetadata(paskirtis, amountSign),
    });
  }
  return out;
};

// Only takes `fileContents`: SEB rows carry their own account IBAN, so the
// `uploadAccountIban` second parameter from the shared `StatementParser`
// signature (which the dispatch map still calls with two arguments) is
// unused here — TS structurally allows a shorter-arity implementation.
export function parseStatement(fileContents: string): ParsedStatement {
  const table = readSebTable(fileContents);
  const firstMalformed = table.malformed[0];
  if (firstMalformed) {
    throw new Error(firstMalformed.message);
  }
  const format = detectFormat('seb', table.headers);
  if (!format) {
    throw new UnrecognizedFormatError('unknown SEB header');
  }
  const duplicates = duplicateHeaders(table.headers);
  if (duplicates.length > 0) {
    throw new UnrecognizedFormatError(
      `duplicate column header: ${duplicates.join(', ')}`,
    );
  }

  const raw: RawInputRow[] = table.records.map(({ rowNumber, cells }) => ({
    rowNumber,
    payload: toPayload(table.headers, cells),
  }));
  const normalized = normalizeRows(raw, '');
  const rows: ParsedRow[] = raw.map(({ rowNumber, payload }) => ({
    rowNumber,
    iban: (payload['SĄSKAITOS NR'] as string).trim(),
    currency: (payload['VALIUTA'] as string).trim(),
    payload,
    bankTransactionId: (payload['TRANSAKCIJOS KODAS'] as string).trim(),
    normalized: normalized.get(rowNumber),
  }));

  return {
    formatVersion: format.version,
    rows,
    declaredPeriods: table.declaredPeriods,
  };
}
