import { createHash } from 'node:crypto';

// A UUID derived from `seed` (version 5 layout), so the same input always gives
// the same key. A retried Telegram update therefore writes to the key the first
// attempt used: a repeat hits S3's `If-None-Match: *` and is a no-op instead of
// a second upload.
export function uuidFromSeed(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  const variant = ((parseInt(h[16] as string, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function statementObjectKey(
  sub: string,
  accountId: string,
  seed: string,
): string {
  return `uploads/${sub}/${accountId}/${uuidFromSeed(seed)}.csv`;
}

// S3 answers 412 when the key already exists (our conditional write).
export function isPreconditionFailed(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === 'PreconditionFailed' || e?.$metadata?.httpStatusCode === 412
  );
}
