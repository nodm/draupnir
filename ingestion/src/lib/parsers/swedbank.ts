import { parseCsv } from '../csv';
import {
  computeHashDedupKeys,
  normalizeDescription,
  resolvePostedDate,
  toMinorUnits,
  type HashDedupKeyInput,
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
  DeclaredBalances,
  DeclaredPeriod,
  NormalizedRow,
  ParsedRow,
  ParsedStatement,
  RawInputRow,
  RowNormalizer,
} from './types';

// Swedbank (Lithuania) exports one comma-delimited, fully quoted table for one
// account (see __fixtures__/swedbank.csv). Differences from a plain table:
//  - the header ends with a trailing empty field, and its second column (the
//    row type) has no name — the raw payload keeps that column under "";
//  - rows omit trailing empty cells, so they are shorter than the header.
// Column 2 is the row type: 10 opening balance, 20 transaction, 82 turnover,
// 86 closing balance, 900 accrued interest. Only 20 enters `transactions`.
const ROW_TYPE = '';
const IBAN = 'Sąskaitos Nr.';
const TYPE_TRANSACTION = '20';
const TYPE_OPENING = '10';
const TYPE_TURNOVER = '82';
const TYPE_CLOSING = '86';

function signOf(debitCredit: string): 1 | -1 {
  const marker = debitCredit.trim();
  if (marker === 'D') return -1;
  if (marker === 'K') return 1;
  throw new Error(`Unrecognized D/K marker: ${debitCredit}`);
}

function signedMinorUnits(payload: Record<string, string>): number {
  return toMinorUnits(
    signOf(payload['D/K'] as string) *
      parseFloat((payload['Suma'] as string).trim()),
    (payload['Valiuta'] as string).trim(),
  );
}

export interface SwedbankTable extends Table {
  declaredPeriods: DeclaredPeriod[];
  // Structural problems (too many cells, missing or repeated balance rows, a
  // period that ends before it starts). Reported by validation; the parser
  // treats any of them as fatal.
  malformed: ValidationReason[];
}

export function readSwedbankTable(fileContents: string): SwedbankTable {
  const lines = parseCsv(fileContents.replace(/^\uFEFF/, ''), ',');
  const [rawHeaders, ...dataLines] = lines;
  if (!rawHeaders) {
    throw new UnrecognizedFormatError('file is empty');
  }
  const headers =
    rawHeaders.length > 1 && rawHeaders[rawHeaders.length - 1] === ''
      ? rawHeaders.slice(0, -1)
      : rawHeaders;

  const malformed: ValidationReason[] = [];
  const records: Table['records'] = [];
  dataLines.forEach((fields, index) => {
    const rowNumber = index + 1;
    const extra = fields.slice(headers.length);
    if (extra.some((cell) => cell !== '')) {
      malformed.push({
        code: 'malformed-row',
        row: rowNumber,
        message: `Row ${rowNumber}: expected at most ${headers.length} cells, got ${fields.length}`,
      });
      return;
    }
    const cells = fields.slice(0, headers.length);
    while (cells.length < headers.length) cells.push('');
    records.push({ rowNumber, cells });
  });

  // One opening and one closing balance row per account.
  const typeIndex = headers.indexOf(ROW_TYPE);
  const ibanIndex = headers.indexOf(IBAN);
  const dateIndex = headers.indexOf('Data');
  const ibans = new Set<string>();
  const balanceRows = new Map<string, { date: string }[]>();
  for (const { cells } of records) {
    const iban = (cells[ibanIndex] ?? '').trim();
    ibans.add(iban);
    const type = cells[typeIndex];
    if (type === TYPE_OPENING || type === TYPE_CLOSING) {
      const key = `${type}|${iban}`;
      balanceRows.set(key, [
        ...(balanceRows.get(key) ?? []),
        { date: cells[dateIndex] ?? '' },
      ]);
    }
  }
  const declaredPeriods: DeclaredPeriod[] = [];
  for (const iban of ibans) {
    const opening = balanceRows.get(`${TYPE_OPENING}|${iban}`) ?? [];
    const closing = balanceRows.get(`${TYPE_CLOSING}|${iban}`) ?? [];
    if (opening.length !== 1 || closing.length !== 1) {
      malformed.push({
        code: 'missing-balance-row',
        message: `Account ${iban}: expected exactly one opening (10) and one closing (86) balance row, found ${opening.length} and ${closing.length}`,
      });
      continue;
    }
    const from = (opening[0] as { date: string }).date;
    const to = (closing[0] as { date: string }).date;
    if (!isRealIsoDatePart(from) || !isRealIsoDatePart(to) || from > to) {
      malformed.push({
        code: 'invalid-declared-period',
        message: `Invalid declared period ${from} to ${to} for ${iban}: not real dates, or start after end`,
      });
      continue;
    }
    declaredPeriods.push({ iban, from, to });
  }

  return { headers, records, declaredPeriods, malformed };
}

// Works from payload keys alone, so it is usable on rows read back from
// `raw_rows`. Rows that are not type 20 have no entry.
export const normalizeRows: RowNormalizer = (rows) => {
  const out = new Map<number, NormalizedRow>();
  const transactions = rows.filter(
    ({ payload }) => payload[ROW_TYPE] === TYPE_TRANSACTION,
  );
  const sourceSeq = fileOrder(transactions.length);

  // The record number is optional; rows without one are keyed by a hash, with
  // the occurrence index ranked among those rows only.
  const hashInputs: HashDedupKeyInput[] = [];
  const hashed: (typeof transactions)[number][] = [];
  const inputOf = ({ payload }: (typeof transactions)[number]) => ({
    iban: (payload[IBAN] as string).trim(),
    postedDate: resolvePostedDate(
      new Date(`${(payload['Data'] as string).trim()}T12:00:00Z`),
    ),
    amountMinorUnits: signedMinorUnits(payload),
    currency: (payload['Valiuta'] as string).trim(),
    normalizedDescription: normalizeDescription(
      payload['Paaiškinimai'] as string,
    ),
  });
  for (const row of transactions) {
    if ((row.payload['Įrašo Nr.'] as string).trim() === '') {
      hashed.push(row);
      hashInputs.push(inputOf(row));
    }
  }
  const hashKeys = computeHashDedupKeys(hashInputs);
  const hashKeyByRow = new Map(
    hashed.map((row, i) => [row.rowNumber, hashKeys[i] as string]),
  );

  transactions.forEach((row, index) => {
    const input = inputOf(row);
    const recordNumber = (row.payload['Įrašo Nr.'] as string).trim();
    out.set(row.rowNumber, {
      iban: input.iban,
      postedDate: input.postedDate,
      amountMinorUnits: input.amountMinorUnits,
      currency: input.currency,
      description: input.normalizedDescription,
      dedupKey:
        recordNumber === ''
          ? (hashKeyByRow.get(row.rowNumber) as string)
          : `swedbank:${recordNumber}`,
      occurredAt: isoFromDateOnly(row.payload['Data'] as string),
      sourceSeq: sourceSeq[index] as number,
      // No fee, per-row balance or FX columns in this export.
      feeMinorUnits: 0,
    });
  });
  return out;
};

function declaredBalancesOf(
  raw: readonly RawInputRow[],
  declaredPeriods: readonly DeclaredPeriod[],
): DeclaredBalances[] {
  return declaredPeriods.map(({ iban }) => {
    const own = raw.filter(({ payload }) => payload[IBAN]?.trim() === iban);
    const ofType = (type: string) =>
      own.filter(({ payload }) => payload[ROW_TYPE] === type);
    const turnoverRows = ofType(TYPE_TURNOVER);
    const sumOf = (marker: 'D' | 'K') =>
      turnoverRows
        .filter(({ payload }) => payload['D/K'] === marker)
        .reduce(
          (sum, { payload }) => sum + Math.abs(signedMinorUnits(payload)),
          0,
        );
    return {
      iban,
      openingMinorUnits: signedMinorUnits(
        (ofType(TYPE_OPENING)[0] as RawInputRow).payload,
      ),
      closingMinorUnits: signedMinorUnits(
        (ofType(TYPE_CLOSING)[0] as RawInputRow).payload,
      ),
      ...(turnoverRows.length > 0
        ? {
            turnover: {
              debitMinorUnits: sumOf('D'),
              creditMinorUnits: sumOf('K'),
            },
          }
        : {}),
    };
  });
}

// Rows carry their own account IBAN, so the upload-selected account is unused.
export function parseStatement(fileContents: string): ParsedStatement {
  const table = readSwedbankTable(fileContents);
  const firstMalformed = table.malformed[0];
  if (firstMalformed) {
    throw new Error(firstMalformed.message);
  }
  const format = detectFormat('swedbank', table.headers);
  if (!format) {
    throw new UnrecognizedFormatError('unknown Swedbank header');
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
  const rows: ParsedRow[] = raw.map(({ rowNumber, payload }) => {
    const recordNumber = (payload['Įrašo Nr.'] as string).trim();
    return {
      rowNumber,
      iban: (payload[IBAN] as string).trim(),
      currency: (payload['Valiuta'] as string).trim(),
      payload,
      bankTransactionId:
        payload[ROW_TYPE] === TYPE_TRANSACTION && recordNumber !== ''
          ? recordNumber
          : null,
      normalized: normalized.get(rowNumber),
    };
  });

  return {
    formatVersion: format.version,
    rows,
    declaredPeriods: table.declaredPeriods,
    declaredBalances: declaredBalancesOf(raw, table.declaredPeriods),
  };
}
