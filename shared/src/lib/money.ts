// Money helpers shared by the apps (moved out of ingestion's dedupKey so `bot`
// can use them: apps may not import each other).

// ISO 4217 currencies whose minor-unit exponent isn't the default of 2 —
// assuming 2 decimals everywhere silently mis-scales amounts (e.g. a JPY
// 100 would become 10,000 minor units) rather than erroring, so this has
// to be explicit rather than assumed.
const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'ISK',
  'JPY',
  'KMF',
  'KRW',
  'PYG',
  'RWF',
  'UGX',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);
const THREE_DECIMAL_CURRENCIES = new Set([
  'BHD',
  'IQD',
  'JOD',
  'KWD',
  'LYD',
  'OMR',
  'TND',
]);
const FOUR_DECIMAL_CURRENCIES = new Set(['CLF', 'UYW']);

export function minorUnitExponent(currency: string): number {
  const code = currency.trim().toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  if (FOUR_DECIMAL_CURRENCIES.has(code)) return 4;
  return 2;
}

// Inverse of toMinorUnits, for human-readable messages: (-1050, 'EUR') -> '-10.50'.
export function formatMinorUnits(minor: number, currency: string): string {
  return (minor / 10 ** minorUnitExponent(currency)).toFixed(
    minorUnitExponent(currency),
  );
}

// Parses what a person types ("1250", "1250.5", "-12,40") into minor units
// without going through floating point. Null for anything that is not a plain
// decimal number, or has more decimals than the currency has.
export function parseMinorUnits(text: string, currency: string): number | null {
  const match = /^([+-])?(\d+)(?:[.,](\d+))?$/.exec(text.trim());
  if (!match) return null;
  const exponent = minorUnitExponent(currency);
  const fraction = match[3] ?? '';
  if (fraction.length > exponent && /[1-9]/.test(fraction.slice(exponent))) {
    return null;
  }
  const digits =
    (match[2] as string) + fraction.slice(0, exponent).padEnd(exponent, '0');
  const value = Number(digits);
  if (!Number.isSafeInteger(value)) return null;
  return match[1] === '-' ? -value : value;
}
