import { createHash } from 'node:crypto';

// Bank statements never carry a timezone offset for their date-only or
// datetime fields; a fixed zone makes `posted_date` resolution deterministic
// regardless of which bank or Lambda region produced the value.
const FIXED_TIMEZONE = 'Europe/Vilnius';

export function normalizeDescription(description: string): string {
  return description.trim().toLowerCase();
}

// ISO 4217 currencies whose minor-unit exponent isn't the default of 2 —
// assuming 2 decimals everywhere silently mis-scales amounts (e.g. a JPY
// 100 would become 10,000 minor units) rather than erroring, so this has
// to be explicit rather than assumed.
const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW',
  'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);
const THREE_DECIMAL_CURRENCIES = new Set([
  'BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND',
]);
const FOUR_DECIMAL_CURRENCIES = new Set(['CLF', 'UYW']);

function minorUnitExponent(currency: string): number {
  const code = currency.trim().toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  if (FOUR_DECIMAL_CURRENCIES.has(code)) return 4;
  return 2;
}

export function toMinorUnits(amount: number, currency: string): number {
  return Math.round(amount * 10 ** minorUnitExponent(currency));
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
