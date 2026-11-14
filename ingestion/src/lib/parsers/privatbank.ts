import { parseCsv } from '../csv';
import {
  computeHashDedupKeys,
  normalizeDescription,
  resolvePostedDate,
  toMinorUnits,
  type HashDedupKeyInput,
} from '../dedupKey';
import { detectFormat, PRIVATBANK_TITLE } from '../validation/formats';
import { isoFromDotted, reverseFileOrder } from './order';
import {
  duplicateHeaders,
  toPayload,
  UnrecognizedFormatError,
  type Table,
} from './table';
import type {
  NormalizedRow,
  ParsedRow,
  ParsedStatement,
  RawInputRow,
  RowNormalizer,
} from './types';

// PrivatBank exports one `;`-delimited table: a title line stating the period
// (ten fields, nine empty), the header, then rows newest first. Numbers use `,`
// as the decimal separator. The card column is a mask that changes when a card
// is reissued, so it never identifies an account: rows belong to the account
// selected at upload (as monobank/Revolut).

// "DD.MM.YYYY HH:MM:SS" -> [date, time]
function splitDateTime(value: string): [string, string] {
  const [date = '', time = '00:00:00'] = value.trim().split(' ');
  return [date, time];
}

function parseDate(value: string): Date {
  const [day, month, year] = splitDateTime(value)[0].split('.') as [
    string,
    string,
    string,
  ];
  return new Date(`${year}-${month}-${day}T12:00:00Z`);
}

const decimal = (value: string): number => parseFloat(value.replace(',', '.'));

export function readPrivatbankTable(fileContents: string): Table {
  const lines = parseCsv(fileContents.replace(/^\uFEFF/, ''), ';');
  const [title, headers, ...rows] = lines;
  if (
    !title ||
    !PRIVATBANK_TITLE.test((title[0] ?? '').trim()) ||
    title.slice(1).some((cell) => cell.trim() !== '')
  ) {
    throw new UnrecognizedFormatError('missing PrivatBank period title line');
  }
  if (!headers) {
    throw new UnrecognizedFormatError('missing header line');
  }
  return {
    headers,
    records: rows.map((cells, index) => ({ rowNumber: index + 1, cells })),
  };
}

// Works from payload keys alone, so it is usable on rows read back from
// `raw_rows`.
export const normalizeRows: RowNormalizer = (rows, accountIban) => {
  const out = new Map<number, NormalizedRow>();
  if (rows.length === 0) return out;

  // Amount, currency and balance are in the card (account) currency so the
  // balance chain stays in it; a different transaction currency is kept as the
  // original amount.
  const hashInputs: HashDedupKeyInput[] = rows.map(({ payload }) => {
    const currency = (payload['Валюта картки'] as string).trim();
    const [, time] = splitDateTime(payload['Дата'] as string);
    return {
      iban: accountIban,
      postedDate: resolvePostedDate(parseDate(payload['Дата'] as string)),
      amountMinorUnits: toMinorUnits(
        decimal(payload['Сума в валюті картки'] as string),
        currency,
      ),
      currency,
      normalizedDescription: normalizeDescription(
        payload['Опис операції'] as string,
      ),
      timeOfDay: time,
    };
  });
  const dedupKeys = computeHashDedupKeys(hashInputs);
  const sourceSeq = reverseFileOrder(rows.length);

  rows.forEach(({ rowNumber, payload }, i) => {
    const input = hashInputs[i] as HashDedupKeyInput;
    const operationCurrency = (payload['Валюта транзакції'] as string).trim();
    const cardAmount = decimal(payload['Сума в валюті картки'] as string);
    out.set(rowNumber, {
      iban: accountIban,
      postedDate: input.postedDate,
      amountMinorUnits: input.amountMinorUnits,
      currency: input.currency,
      description: input.normalizedDescription,
      dedupKey: dedupKeys[i] as string,
      occurredAt: isoFromDotted(payload['Дата'] as string),
      sourceSeq: sourceSeq[i] as number,
      feeMinorUnits: 0,
      balanceAfterMinorUnits: toMinorUnits(
        decimal(payload['Залишок на кінець періоду'] as string),
        input.currency,
      ),
      ...(operationCurrency !== input.currency
        ? {
            originalCurrency: operationCurrency,
            // The column is a magnitude; its sign follows the card amount.
            originalAmountMinorUnits:
              (cardAmount < 0 ? -1 : 1) *
              toMinorUnits(
                decimal(payload['Сума в валюті транзакції'] as string),
                operationCurrency,
              ),
          }
        : {}),
    });
  });
  return out;
};

export function parseStatement(
  fileContents: string,
  uploadAccountIban: string,
): ParsedStatement {
  const table = readPrivatbankTable(fileContents);
  const format = detectFormat('privatbank', table.headers);
  if (!format) {
    throw new UnrecognizedFormatError('unknown PrivatBank header');
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
  const normalized = normalizeRows(raw, uploadAccountIban);
  const rows: ParsedRow[] = raw.map(({ rowNumber, payload }) => ({
    rowNumber,
    iban: uploadAccountIban,
    currency: (payload['Валюта картки'] as string).trim(),
    payload,
    bankTransactionId: null,
    normalized: normalized.get(rowNumber),
  }));

  return { formatVersion: format.version, rows, declaredPeriods: [] };
}
