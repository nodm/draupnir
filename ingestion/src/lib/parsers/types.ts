export interface NormalizedRow {
  iban: string;
  postedDate: string;
  amountMinorUnits: number;
  currency: string;
  description: string;
  dedupKey: string;
  // When the balance changed, ISO 8601 UTC (see parsers/order.ts), and the
  // row's place in its file's chronological order. Together with the stored
  // row id they order an account's transactions.
  occurredAt: string;
  sourceSeq: number;
  // 0 when the bank reports no fee.
  feeMinorUnits: number;
  // Absent when the bank's format has no per-row balance (SEB).
  balanceAfterMinorUnits?: number;
  originalCurrency?: string;
  originalAmountMinorUnits?: number;
  fxFeeMinorUnits?: number;
  fxFeePercent?: number;
}

// A raw row as stored in `raw_rows`: what normalization works from, so the same
// code derives transactions at import time and when an account is rebuilt.
export interface RawInputRow {
  rowNumber: number;
  payload: Record<string, string>;
}

// Normalizes one file's (or one account's share of a file's) rows. Keyed by
// row number; rows that don't enter `transactions` have no entry.
export type RowNormalizer = (
  rows: readonly RawInputRow[],
  accountIban: string,
) => Map<number, NormalizedRow>;

export interface ParsedRow {
  // 1-based index among the file's data rows (title and header lines don't
  // count), so it identifies a row in rejection reasons and `raw_rows`.
  rowNumber: number;
  // Account the row belongs to: the row's own IBAN (SEB) or the upload-selected
  // account's IBAN (Revolut, monobank). Set for raw-only rows too.
  iban: string;
  // The row's own currency, set for raw-only rows too, so the account's
  // currency can be enforced on every row of the file.
  currency: string;
  // Original header -> original cell string, untouched.
  payload: Record<string, string>;
  bankTransactionId: string | null;
  // Absent for rows that don't enter `transactions` (e.g. Revolut PENDING).
  normalized?: NormalizedRow;
}

export interface DeclaredPeriod {
  iban: string;
  from: string;
  to: string;
}

export interface ParsedStatement {
  formatVersion: string;
  rows: ParsedRow[];
  // Periods the export itself declares (SEB title lines); empty otherwise.
  declaredPeriods: DeclaredPeriod[];
}

export type StatementParser = (
  fileContents: string,
  uploadAccountIban: string,
) => ParsedStatement;
