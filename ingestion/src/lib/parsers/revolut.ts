import {
  computeHashDedupKeys,
  normalizeDescription,
  resolvePostedDate,
  toMinorUnits,
  type HashDedupKeyInput,
} from '../dedupKey';
import { detectFormat } from '../validation/formats';
import { isoFromSpaceSeparated, rankByTime } from './order';
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

// Only a COMPLETED row on the main ("Current") product moves the account's
// balance and enters `transactions`; every other row is kept raw-only.
const NORMALIZED_STATE = 'COMPLETED';
const NORMALIZED_PRODUCT = 'Current';

function parseRevolutDate(value: string): Date {
  const datePart = value.trim().split(' ')[0] as string;
  return new Date(`${datePart}T12:00:00Z`);
}

export const normalizeRows: RowNormalizer = (rows, accountIban) => {
  const entries = rows.filter(
    ({ payload }) =>
      payload['State'] === NORMALIZED_STATE &&
      payload['Product'] === NORMALIZED_PRODUCT,
  );

  // `Started Date` — not `Completed Date` — is the posting and dedup basis:
  // it doesn't change when a pending transaction later completes.
  const hashInputs: HashDedupKeyInput[] = entries.map(({ payload }) => ({
    iban: accountIban,
    postedDate: resolvePostedDate(
      parseRevolutDate(payload['Started Date'] as string),
    ),
    amountMinorUnits: toMinorUnits(
      parseFloat(payload['Amount'] as string),
      payload['Currency'] as string,
    ),
    currency: (payload['Currency'] as string).trim(),
    normalizedDescription: normalizeDescription(
      payload['Description'] as string,
    ),
  }));
  const dedupKeys = computeHashDedupKeys(hashInputs);
  // The balance changes on completion, not at the start.
  const occurredAt = entries.map(({ payload }) =>
    isoFromSpaceSeparated(payload['Completed Date'] as string),
  );
  const sourceSeq = rankByTime(occurredAt);

  const out = new Map<number, NormalizedRow>();
  entries.forEach(({ rowNumber, payload }, index) => {
    const input = hashInputs[index] as HashDedupKeyInput;
    out.set(rowNumber, {
      iban: accountIban,
      postedDate: input.postedDate,
      amountMinorUnits: input.amountMinorUnits,
      currency: input.currency,
      description: input.normalizedDescription,
      dedupKey: dedupKeys[index] as string,
      occurredAt: occurredAt[index] as string,
      sourceSeq: sourceSeq[index] as number,
      feeMinorUnits: toMinorUnits(
        parseFloat(payload['Fee'] as string),
        input.currency,
      ),
      balanceAfterMinorUnits: toMinorUnits(
        parseFloat(payload['Balance'] as string),
        input.currency,
      ),
    });
  });
  return out;
};

export function parseStatement(
  fileContents: string,
  uploadAccountIban: string,
): ParsedStatement {
  const table = readSimpleTable(fileContents, ',');
  const format = detectFormat('revolut', table.headers);
  if (!format) {
    throw new UnrecognizedFormatError('unknown Revolut header');
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
    currency: (payload['Currency'] as string).trim(),
    payload,
    bankTransactionId: null,
    normalized: normalized.get(rowNumber),
  }));

  return { formatVersion: format.version, rows, declaredPeriods: [] };
}
