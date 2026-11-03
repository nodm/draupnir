import { z } from 'zod';
import type { Bank } from 'shared';

// One entry per (bank, format version). A format declares how to recognise its
// header and a zod schema over a row's *string* cells (the raw payload), so a
// new export layout is a new entry, not a code path.

export interface FormatVersion {
  bank: Bank;
  version: string;
  delimiter: string;
  matchesHeaders(headers: readonly string[]): boolean;
  rowSchema: z.ZodType;
  // Maps a payload (original headers) to the keys `rowSchema` expects.
  schemaInput(
    payload: Record<string, string>,
    headers: readonly string[],
  ): Record<string, string>;
}

// `new Date('2026-02-31')` silently rolls over to March, so calendar validity
// is checked on the parts. Malformed shapes pass here; the regex reports them.
function isRealDate(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

export function isRealIsoDatePart(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return !m || isRealDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

function isRealDottedDatePart(value: string): boolean {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(value);
  return !m || isRealDate(Number(m[3]), Number(m[2]), Number(m[1]));
}

const NOT_A_DATE = 'is not a real calendar date';

// Amounts are converted to integer minor units (up to 4 decimals) and stored
// in bigint columns; beyond this magnitude parseFloat loses precision or
// overflows to Infinity, so such a cell is a rejection, not a silent value.
export const MAX_AMOUNT_MAJOR_UNITS = 9e11;

function isSafeAmount(value: string): boolean {
  // A malformed shape is reported by the regex; don't also report it here.
  if (!/^-?\d+([.,]\d+)?$/.test(value)) return true;
  const n = Number.parseFloat(value.replace(',', '.'));
  return Number.isFinite(n) && Math.abs(n) <= MAX_AMOUNT_MAJOR_UNITS;
}

const money = (label: string) =>
  z
    .string()
    .regex(/^-?\d+(\.\d+)?$/, `${label} must be a decimal number`)
    .refine(isSafeAmount, `${label} is out of range`);
const nonEmpty = (label: string) =>
  z.string().refine((v) => v.trim().length > 0, `${label} must not be empty`);

// ---- SEB ----

export const SEB_HEADERS = [
  'DOK NR.',
  'DATA',
  'VALIUTA',
  'SUMA',
  'MOKĖTOJO ARBA GAVĖJO PAVADINIMAS',
  'MOKĖTOJO ARBA GAVĖJO IDENTIFIKACINIS KODAS',
  'SĄSKAITA',
  'KREDITO ĮSTAIGOS PAVADINIMAS',
  'KREDITO ĮSTAIGOS SWIFT KODAS',
  'MOKĖJIMO PASKIRTIS',
  'TRANSAKCIJOS KODAS',
  'DOKUMENTO DATA',
  'TRANSAKCIJOS TIPAS',
  'NUORODA',
  'DEBETAS/KREDITAS',
  'SUMA SĄSKAITOS VALIUTA',
  'SĄSKAITOS NR',
  'SĄSKAITOS VALIUTA',
] as const;

const sebRow = z.object({
  DATA: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'DATA must be YYYY-MM-DD')
    .refine(isRealIsoDatePart, `DATA ${NOT_A_DATE}`),
  VALIUTA: z.string().regex(/^[A-Z]{3}$/, 'VALIUTA must be a currency code'),
  SUMA: z
    .string()
    .regex(/^\d+(,\d+)?$/, 'SUMA must be a decimal like 50,00')
    .refine(isSafeAmount, 'SUMA is out of range'),
  'MOKĖJIMO PASKIRTIS': z.string(),
  'TRANSAKCIJOS KODAS': nonEmpty('TRANSAKCIJOS KODAS'),
  'DEBETAS/KREDITAS': z.enum(['D', 'C'], {
    error: 'DEBETAS/KREDITAS must be D or C',
  }),
  'SĄSKAITOS NR': nonEmpty('SĄSKAITOS NR'),
});

const sebV1: FormatVersion = {
  bank: 'seb',
  version: 'seb-v1',
  delimiter: ';',
  matchesHeaders: (headers) =>
    headers.length === SEB_HEADERS.length &&
    SEB_HEADERS.every((h, i) => headers[i] === h),
  rowSchema: sebRow,
  schemaInput: (payload) => payload,
};

// ---- Revolut ----

export const REVOLUT_HEADERS = [
  'Type',
  'Product',
  'Started Date',
  'Completed Date',
  'Description',
  'Amount',
  'Fee',
  'Currency',
  'State',
  'Balance',
] as const;

const REVOLUT_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

const revolutRow = z
  .object({
    Type: z.string(),
    Product: nonEmpty('Product'),
    'Started Date': z
      .string()
      .regex(REVOLUT_DATETIME, 'Started Date must be YYYY-MM-DD HH:MM:SS')
      .refine(isRealIsoDatePart, `Started Date ${NOT_A_DATE}`),
    'Completed Date': z.string(),
    Description: z.string(),
    Amount: money('Amount'),
    Fee: money('Fee'),
    Currency: z
      .string()
      .regex(/^[A-Z]{3}$/, 'Currency must be a currency code'),
    State: nonEmpty('State'),
    Balance: z.string(),
  })
  .superRefine((row, ctx) => {
    // Only COMPLETED rows move the balance, so only they must carry one.
    if (row.State !== 'COMPLETED') return;
    if (
      REVOLUT_DATETIME.test(row['Completed Date']) &&
      !isRealIsoDatePart(row['Completed Date'])
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['Completed Date'],
        message: `Completed Date ${NOT_A_DATE}`,
      });
    }
    if (!REVOLUT_DATETIME.test(row['Completed Date'])) {
      ctx.addIssue({
        code: 'custom',
        path: ['Completed Date'],
        message:
          'Completed Date must be YYYY-MM-DD HH:MM:SS for a COMPLETED row',
      });
    }
    if (!/^-?\d+(\.\d+)?$/.test(row.Balance)) {
      ctx.addIssue({
        code: 'custom',
        path: ['Balance'],
        message: 'Balance must be a decimal number for a COMPLETED row',
      });
    } else if (!isSafeAmount(row.Balance)) {
      ctx.addIssue({
        code: 'custom',
        path: ['Balance'],
        message: 'Balance is out of range',
      });
    }
  });

const revolutV1: FormatVersion = {
  bank: 'revolut',
  version: 'revolut-v1',
  delimiter: ',',
  matchesHeaders: (headers) =>
    headers.length === REVOLUT_HEADERS.length &&
    REVOLUT_HEADERS.every((h, i) => headers[i] === h),
  rowSchema: revolutRow,
  schemaInput: (payload) => payload,
};

// ---- monobank ----

// The card-currency columns embed the currency in the header text, e.g.
// "Card currency amount, (UAH)", so they are matched by prefix and the
// currency is read from the header (see `monobankCardCurrency`).
const MONOBANK_FIXED: Record<number, string> = {
  0: 'Date and time',
  1: 'Description',
  2: 'MCC',
  4: 'Operation amount',
  5: 'Operation currency',
  6: 'Exchange rate',
  9: 'Balance',
};
const MONOBANK_PREFIXED: Record<number, string> = {
  3: 'Card currency amount',
  7: 'Commission',
  8: 'Cashback amount',
};
export const MONOBANK_COLUMN_COUNT = 10;
export const MONOBANK_CARD_AMOUNT_INDEX = 3;
export const MONOBANK_COMMISSION_INDEX = 7;

export function monobankCardCurrency(
  headers: readonly string[],
): string | undefined {
  return /\(([A-Z]{3})\)/.exec(headers[MONOBANK_CARD_AMOUNT_INDEX] ?? '')?.[1];
}

// The same, from a payload's keys (order-independent, as stored jsonb is).
export function monobankCardCurrencyOf(
  payload: Record<string, string>,
): string | undefined {
  const key = Object.keys(payload).find((k) =>
    k.startsWith('Card currency amount'),
  );
  return key ? /\(([A-Z]{3})\)/.exec(key)?.[1] : undefined;
}

const optionalMoney = (label: string) =>
  z
    .string()
    .regex(/^(—|-?\d+(\.\d+)?)$/, `${label} must be a decimal number or —`)
    .refine((v) => v === '—' || isSafeAmount(v), `${label} is out of range`);

// Keys are the header texts, which for the three card-currency columns depend
// on the account currency, so rows are validated after normalising those keys
// (see `canonicalMonobankPayload`).
const monobankRow = z.object({
  'Date and time': z
    .string()
    .regex(
      /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}$/,
      'Date and time must be DD.MM.YYYY HH:MM:SS',
    )
    .refine(isRealDottedDatePart, `Date and time ${NOT_A_DATE}`),
  Description: z.string(),
  MCC: z.string().regex(/^\d*$/, 'MCC must be digits'),
  'Card currency amount': money('Card currency amount'),
  'Operation amount': money('Operation amount'),
  'Operation currency': z
    .string()
    .regex(/^[A-Z]{3}$/, 'Operation currency must be a currency code'),
  'Exchange rate': optionalMoney('Exchange rate'),
  Commission: optionalMoney('Commission'),
  'Cashback amount': optionalMoney('Cashback amount'),
  Balance: money('Balance'),
});

// Replaces the three currency-suffixed header names with their fixed prefix.
export function canonicalMonobankPayload(
  payload: Record<string, string>,
): Record<string, string> {
  const prefixes = Object.values(MONOBANK_PREFIXED);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    out[prefixes.find((prefix) => key.startsWith(prefix)) ?? key] = value;
  }
  return out;
}

const monobankV1: FormatVersion = {
  bank: 'monobank',
  version: 'monobank-v1',
  delimiter: ',',
  matchesHeaders: (headers) =>
    headers.length === MONOBANK_COLUMN_COUNT &&
    Object.entries(MONOBANK_FIXED).every(
      ([i, name]) => headers[Number(i)] === name,
    ) &&
    Object.entries(MONOBANK_PREFIXED).every(([i, prefix]) =>
      (headers[Number(i)] ?? '').startsWith(prefix),
    ) &&
    monobankCardCurrency(headers) !== undefined,
  rowSchema: monobankRow,
  schemaInput: (payload) => canonicalMonobankPayload(payload),
};

const FORMATS: Record<Bank, readonly FormatVersion[]> = {
  seb: [sebV1],
  revolut: [revolutV1],
  monobank: [monobankV1],
};

export function detectFormat(
  bank: Bank,
  headers: readonly string[],
): FormatVersion | undefined {
  return FORMATS[bank].find((format) => format.matchesHeaders(headers));
}
