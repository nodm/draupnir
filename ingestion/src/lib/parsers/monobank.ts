import {
  computeHashDedupKeys,
  normalizeDescription,
  resolvePostedDate,
  toMinorUnits,
  type HashDedupKeyInput,
} from '../dedupKey';
import {
  canonicalMonobankPayload,
  detectFormat,
  monobankCardCurrencyOf,
} from '../validation/formats';
import { isoFromDotted, reverseFileOrder } from './order';
import {
  duplicateHeaders,
  readSimpleTable,
  toPayload,
  UnrecognizedFormatError,
} from './table';
import type {
  NormalizedRow,
  ParsedRow,
  ParsedStatement,
  RawInputRow,
  RowNormalizer,
} from './types';

// monobank writes `—` for an empty numeric cell.
const EMPTY_CELL = '—';

function parseMonobankDate(value: string): Date {
  const datePart = value.trim().split(' ')[0] as string;
  const [day, month, year] = datePart.split('.') as [string, string, string];
  return new Date(`${year}-${month}-${day}T12:00:00Z`);
}

function optionalAmount(value: string, currency: string): number {
  return value === EMPTY_CELL ? 0 : toMinorUnits(parseFloat(value), currency);
}

// Works from payload keys alone (jsonb doesn't keep column order), so it is
// usable on rows read back from `raw_rows`.
export const normalizeRows: RowNormalizer = (rows, accountIban) => {
  const out = new Map<number, NormalizedRow>();
  if (rows.length === 0) return out;

  const cards = rows.map(({ payload }) => canonicalMonobankPayload(payload));
  const cardCurrency = monobankCardCurrencyOf(rows[0]?.payload ?? {});
  if (!cardCurrency) {
    throw new UnrecognizedFormatError('monobank card currency not found');
  }

  // The transaction is stored in the card's (account) currency so that it
  // agrees with the running balance; a different operation currency is kept
  // as the original amount.
  const hashInputs: HashDedupKeyInput[] = cards.map((cells) => ({
    iban: accountIban,
    postedDate: resolvePostedDate(
      parseMonobankDate(cells['Date and time'] as string),
    ),
    amountMinorUnits: toMinorUnits(
      parseFloat(cells['Card currency amount'] as string),
      cardCurrency,
    ),
    currency: cardCurrency,
    normalizedDescription: normalizeDescription(cells['Description'] as string),
  }));
  const dedupKeys = computeHashDedupKeys(hashInputs);
  const sourceSeq = reverseFileOrder(rows.length);

  rows.forEach(({ rowNumber }, i) => {
    const cells = cards[i] as Record<string, string>;
    const input = hashInputs[i] as HashDedupKeyInput;
    const operationCurrency = (cells['Operation currency'] as string).trim();
    out.set(rowNumber, {
      iban: accountIban,
      postedDate: input.postedDate,
      amountMinorUnits: input.amountMinorUnits,
      currency: cardCurrency,
      description: input.normalizedDescription,
      dedupKey: dedupKeys[i] as string,
      occurredAt: isoFromDotted(cells['Date and time'] as string),
      sourceSeq: sourceSeq[i] as number,
      feeMinorUnits: optionalAmount(
        cells['Commission'] as string,
        cardCurrency,
      ),
      balanceAfterMinorUnits: toMinorUnits(
        parseFloat(cells['Balance'] as string),
        cardCurrency,
      ),
      ...(operationCurrency !== cardCurrency
        ? {
            originalCurrency: operationCurrency,
            originalAmountMinorUnits: toMinorUnits(
              parseFloat(cells['Operation amount'] as string),
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
  const table = readSimpleTable(fileContents, ',');
  const format = detectFormat('monobank', table.headers);
  if (!format) {
    throw new UnrecognizedFormatError('unknown monobank header');
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
  const cardCurrency = monobankCardCurrencyOf(raw[0]?.payload ?? {}) ?? '';
  const rows: ParsedRow[] = raw.map(({ rowNumber, payload }) => ({
    rowNumber,
    iban: uploadAccountIban,
    currency: cardCurrency,
    payload,
    bankTransactionId: null,
    normalized: normalized.get(rowNumber),
  }));

  return { formatVersion: format.version, rows, declaredPeriods: [] };
}
