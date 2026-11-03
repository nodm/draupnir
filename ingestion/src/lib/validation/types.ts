// A human-readable reason a file was rejected (hard) or flagged (warning).
// `row` is the 1-based data-row number when the reason is about one row.
export interface ValidationReason {
  code: string;
  message: string;
  row?: number;
}
