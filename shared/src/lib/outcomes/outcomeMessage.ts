// What the ingestion pipeline publishes for every processed file (spec:
// statement-ingestion-pipeline). It carries no transaction rows, and says
// nothing about how the file arrived, so any channel can consume it.

export interface OutcomeReason {
  code: string;
  message: string;
  // 1-based data row, when the reason is about one row.
  row?: number;
}

export interface StatementOutcomeMessage {
  // Null for a rejection that could not be recorded (the uploader no longer
  // owns the account), which therefore has no outbox row.
  fileId: string | null;
  s3Key: string;
  // The uploader's identity, from the object key.
  sub: string;
  status: 'approved' | 'rejected';
  // Hard reasons; empty for an approved file.
  reasons: OutcomeReason[];
  // Per account id; empty for a rejected file.
  warningsByAccount: Record<string, OutcomeReason[]>;
  // Newly created transactions across all accounts; 0 for a rejected file.
  newTransactionCount: number;
  // Dates covered by an approved file; null for a rejected one.
  period: { from: string | null; to: string | null } | null;
}

export function isOutcomeMessage(
  value: unknown,
): value is StatementOutcomeMessage {
  const v = value as Partial<StatementOutcomeMessage> | null;
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof v.s3Key === 'string' &&
    typeof v.sub === 'string' &&
    (v.status === 'approved' || v.status === 'rejected') &&
    Array.isArray(v.reasons)
  );
}

// The earliest start and latest end across an approved file's accounts.
export function coveredPeriod(
  segments: readonly { from: string | null; to: string | null }[],
): { from: string | null; to: string | null } {
  let from: string | null = null;
  let to: string | null = null;
  for (const s of segments) {
    if (s.from !== null && (from === null || s.from < from)) from = s.from;
    if (s.to !== null && (to === null || s.to > to)) to = s.to;
  }
  return { from, to };
}
