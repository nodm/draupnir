// How long the uploads bucket keeps an uploaded statement file. Nothing reads
// an upload after its outcome is committed; the only later reader is a redrive
// from the ingestion DLQ, so an upload must outlive its dead-letter message.
// See openspec/changes/expire-uploads-and-enforce-size-at-s3/design.md
// (decisions 1-3).

export const UPLOAD_RETENTION_CONFIG_KEY = 'draupnir-infra:uploadRetentionDays';
export const DEFAULT_UPLOAD_RETENTION_DAYS = 30;

// The SQS maximum. For a standard queue the expiry counts from the message's
// original enqueue, so a dead-lettered file's message is gone 14 days after
// its upload at the latest.
export const INGESTION_DLQ_RETENTION_DAYS = 14;

// Returns the retention in days, or throws so that `pulumi preview` fails
// before any resource changes.
export function uploadRetentionDays(value: string | undefined): number {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_UPLOAD_RETENTION_DAYS;
  }
  const trimmed = value.trim();
  const days = Number(trimmed);
  if (
    !/^\d+$/.test(trimmed) ||
    !Number.isSafeInteger(days) ||
    days <= INGESTION_DLQ_RETENTION_DAYS
  ) {
    throw new Error(
      `${UPLOAD_RETENTION_CONFIG_KEY} "${value}" must be a whole number of days ` +
        `greater than ${INGESTION_DLQ_RETENTION_DAYS} (the ingestion DLQ retention), ` +
        `so a dead-lettered file can still be reprocessed`,
    );
  }
  return days;
}
