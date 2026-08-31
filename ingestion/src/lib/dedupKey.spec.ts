import {
  computeHashDedupKey,
  computeHashDedupKeys,
  normalizeDescription,
  resolvePostedDate,
  toMinorUnits,
} from './dedupKey';

describe('normalizeDescription', () => {
  it('trims whitespace and case-folds', () => {
    expect(normalizeDescription('  Lidl PURCHASE  ')).toBe('lidl purchase');
  });

  it('treats whitespace/casing variants as identical', () => {
    expect(normalizeDescription('LIDL')).toBe(normalizeDescription(' lidl '));
  });
});

describe('toMinorUnits', () => {
  it('rounds a decimal amount to minor units for a 2-decimal currency', () => {
    expect(toMinorUnits(22.23, 'EUR')).toBe(2223);
    expect(toMinorUnits(-0.29, 'EUR')).toBe(-29);
  });

  it('treats a zero-decimal currency as having no minor units', () => {
    expect(toMinorUnits(100, 'JPY')).toBe(100);
    expect(toMinorUnits(1500, 'KRW')).toBe(1500);
  });

  it('scales a three-decimal currency by 1000', () => {
    expect(toMinorUnits(12.345, 'BHD')).toBe(12345);
  });

  it('scales a four-decimal currency by 10000', () => {
    expect(toMinorUnits(1.2345, 'CLF')).toBe(12345);
    expect(toMinorUnits(1.2345, 'UYW')).toBe(12345);
  });

  it('is case-insensitive on the currency code', () => {
    expect(toMinorUnits(100, 'jpy')).toBe(100);
  });
});

describe('resolvePostedDate', () => {
  it('resolves to a fixed-timezone YYYY-MM-DD string', () => {
    expect(resolvePostedDate(new Date('2026-08-29T00:00:00Z'))).toBe(
      '2026-08-29',
    );
  });
});

const baseRow = {
  iban: 'LT100000000000000001',
  postedDate: '2026-08-29',
  amountMinorUnits: -1050,
  currency: 'EUR',
  normalizedDescription: 'lidl',
};

describe('computeHashDedupKey', () => {
  it('is deterministic for identical input', () => {
    expect(computeHashDedupKey(baseRow, 0)).toBe(
      computeHashDedupKey(baseRow, 0),
    );
  });

  it('differs when occurrenceIndex differs', () => {
    expect(computeHashDedupKey(baseRow, 0)).not.toBe(
      computeHashDedupKey(baseRow, 1),
    );
  });
});

describe('computeHashDedupKeys', () => {
  it('assigns increasing occurrence indexes to same-file identical-looking rows, producing distinct keys', () => {
    const rows = [baseRow, baseRow, baseRow];

    const keys = computeHashDedupKeys(rows);

    expect(new Set(keys).size).toBe(3);
    expect(keys[0]).toBe(computeHashDedupKey(baseRow, 0));
    expect(keys[1]).toBe(computeHashDedupKey(baseRow, 1));
    expect(keys[2]).toBe(computeHashDedupKey(baseRow, 2));
  });

  it('re-parsing the same file produces the same keys', () => {
    const rows = [baseRow, { ...baseRow }, { ...baseRow }];

    expect(computeHashDedupKeys(rows)).toEqual(computeHashDedupKeys(rows));
  });

  it('does not let distinct rows collide with each other', () => {
    const other = { ...baseRow, amountMinorUnits: -999 };

    const keys = computeHashDedupKeys([baseRow, other]);

    expect(keys[0]).not.toBe(keys[1]);
  });
});
