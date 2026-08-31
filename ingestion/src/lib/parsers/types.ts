export interface NormalizedRow {
  iban: string;
  postedDate: string;
  amountMinorUnits: number;
  currency: string;
  description: string;
  dedupKey: string;
  originalCurrency?: string;
  originalAmountMinorUnits?: number;
  fxFeeMinorUnits?: number;
  fxFeePercent?: number;
}

export type StatementParser = (
  fileContents: string,
  uploadAccountIban: string,
) => NormalizedRow[];
