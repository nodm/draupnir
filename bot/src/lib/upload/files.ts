import type { Document } from '@grammyjs/types';

// Telegram lets bots download up to 20 MB; ingestion rejects anything over
// MAX_STATEMENT_BYTES (shared), so refuse that here instead of uploading a file
// the pipeline would throw on.
export { MAX_STATEMENT_BYTES } from 'shared';

const CSV_MIME_TYPES = new Set([
  'text/csv',
  'text/comma-separated-values',
  'application/csv',
  // Some Android share sheets label a .csv this way.
  'application/vnd.ms-excel',
]);

export function isCsvDocument(document: Document): boolean {
  if (/\.csv$/i.test(document.file_name ?? '')) return true;
  return CSV_MIME_TYPES.has((document.mime_type ?? '').toLowerCase());
}
