// The largest bank statement file accepted, in bytes. One number for every
// place that enforces it: the presigned POST policy (S3 refuses a larger file
// before storing it), the Telegram bot (refuses before its own PutObject), and
// the ingestion worker (re-checks every object, whoever wrote it).
export const MAX_STATEMENT_BYTES = 10 * 1024 * 1024;
