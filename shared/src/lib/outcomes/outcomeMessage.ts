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
  // `reasons` / `warningsByAccount` are bounded to keep the message small (see
  // boundOutcomeMessage); these count what was left out. Absent = nothing.
  omittedReasonCount?: number;
  omittedWarningCount?: number;
}

// SQS bodies are limited to 256 KiB, and a 10 MB CSV can produce a reason per
// row. The full list stays in `statement_files.rejection_reasons`; the message
// carries the first reasons and how many were left out.
export const MAX_MESSAGE_REASONS = 30;
const MAX_REASON_TEXT = 500;

const clipReason = (reason: OutcomeReason): OutcomeReason => ({
  ...reason,
  message:
    reason.message.length > MAX_REASON_TEXT
      ? `${reason.message.slice(0, MAX_REASON_TEXT)}…`
      : reason.message,
});

export function boundOutcomeMessage(
  message: StatementOutcomeMessage,
): StatementOutcomeMessage {
  const reasons = message.reasons.slice(0, MAX_MESSAGE_REASONS).map(clipReason);

  const warningsByAccount: Record<string, OutcomeReason[]> = {};
  let keptWarnings = 0;
  let totalWarnings = 0;
  for (const [accountId, warnings] of Object.entries(
    message.warningsByAccount,
  )) {
    totalWarnings += warnings.length;
    const room = Math.max(0, MAX_MESSAGE_REASONS - keptWarnings);
    const kept = warnings.slice(0, room).map(clipReason);
    keptWarnings += kept.length;
    if (kept.length > 0) warningsByAccount[accountId] = kept;
  }

  return {
    ...message,
    reasons,
    warningsByAccount,
    omittedReasonCount: message.reasons.length - reasons.length,
    omittedWarningCount: totalWarnings - keptWarnings,
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isReason = (v: unknown): v is OutcomeReason =>
  isRecord(v) &&
  typeof v['code'] === 'string' &&
  typeof v['message'] === 'string' &&
  (v['row'] === undefined || typeof v['row'] === 'number');

const isDate = (v: unknown) => v === null || typeof v === 'string';

// Validates the whole shape, not just the discriminating fields: this routes
// every record on the bot's queue and what passes is formatted without further
// checks, so a half-formed message must not pass.
export function isOutcomeMessage(
  value: unknown,
): value is StatementOutcomeMessage {
  if (!isRecord(value)) return false;
  const { warningsByAccount, period } = value;
  return (
    (value['fileId'] === null || typeof value['fileId'] === 'string') &&
    typeof value['s3Key'] === 'string' &&
    typeof value['sub'] === 'string' &&
    (value['status'] === 'approved' || value['status'] === 'rejected') &&
    Array.isArray(value['reasons']) &&
    value['reasons'].every(isReason) &&
    isRecord(warningsByAccount) &&
    Object.values(warningsByAccount).every(
      (w) => Array.isArray(w) && w.every(isReason),
    ) &&
    typeof value['newTransactionCount'] === 'number' &&
    Number.isFinite(value['newTransactionCount']) &&
    (period === null ||
      (isRecord(period) && isDate(period['from']) && isDate(period['to']))) &&
    (value['omittedReasonCount'] === undefined ||
      typeof value['omittedReasonCount'] === 'number') &&
    (value['omittedWarningCount'] === undefined ||
      typeof value['omittedWarningCount'] === 'number')
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
