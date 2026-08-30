import { createHash } from 'node:crypto';

// Bank statements never carry a timezone offset for their date-only or
// datetime fields; a fixed zone makes `posted_date` resolution deterministic
// regardless of which bank or Lambda region produced the value.
const FIXED_TIMEZONE = 'Europe/Vilnius';

export function normalizeDescription(description: string): string {
  return description.trim().toLowerCase();
}

export function toMinorUnits(amount: number): number {
  return Math.round(amount * 100);
}

export function resolvePostedDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: FIXED_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

// The account identifier available at parse time is the row's IBAN — the
// parser has no DB access to resolve a real `accounts.id`, and IBAN is
// itself a stable real-world account identifier.
export interface HashDedupKeyInput {
  iban: string;
  postedDate: string;
  amountMinorUnits: number;
  currency: string;
  normalizedDescription: string;
}

function groupingKey(input: HashDedupKeyInput): string {
  return [
    input.iban,
    input.postedDate,
    input.amountMinorUnits,
    input.currency,
    input.normalizedDescription,
  ].join('|');
}

export function computeHashDedupKey(
  input: HashDedupKeyInput,
  occurrenceIndex: number,
): string {
  return createHash('sha256')
    .update(`${groupingKey(input)}|${occurrenceIndex}`)
    .digest('hex');
}

// Assigns each row's rank (0-based) among rows in the same file sharing
// identical account/date/amount/currency/description — computed in one pass
// over the file's parsed rows, not a DB sequence, per the
// re-parse-stability requirement in the bank-statement-parsers spec.
export function computeHashDedupKeys<T extends HashDedupKeyInput>(
  rows: readonly T[],
): string[] {
  const seenCounts = new Map<string, number>();

  return rows.map((row) => {
    const key = groupingKey(row);
    const occurrenceIndex = seenCounts.get(key) ?? 0;
    seenCounts.set(key, occurrenceIndex + 1);
    return computeHashDedupKey(row, occurrenceIndex);
  });
}
