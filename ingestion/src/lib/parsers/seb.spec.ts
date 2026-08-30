import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStatement } from './seb';

const fixture = readFileSync(
  join(__dirname, '__fixtures__/seb.csv'),
  'utf8',
);

describe('SEB parseStatement', () => {
  it('parses a normal row', () => {
    const rows = parseStatement(fixture);
    const lidl = rows.find((row) => row.dedupKey === 'seb:RO1000000003L01');

    expect(lidl).toEqual({
      iban: 'LT100000000000000002',
      postedDate: '2026-08-29',
      amountMinorUnits: -6488,
      currency: 'EUR',
      description:
        '28/08/2026 19:17 kortelė...000000 lidl/60175 lidl zalgir/vilnius/ltu #869452, dok. nr. clr10000001, operacijos nr. ro1000000003l01',
      dedupKey: 'seb:RO1000000003L01',
    });
  });

  it('normalizes description whitespace/casing', () => {
    const rows = parseStatement(fixture);
    const row = rows.find((r) => r.dedupKey === 'seb:RD300000001');

    expect(row?.description).toBe(row?.description.trim().toLowerCase());
    expect(row?.description).not.toMatch(/[A-Z]/);
  });

  it('produces rows for both IBANs in a file spanning two accounts', () => {
    const rows = parseStatement(fixture);
    const ibans = new Set(rows.map((row) => row.iban));

    expect(ibans).toEqual(
      new Set(['LT100000000000000002', 'LT100000000000000001']),
    );
  });

  it('does not collide two legs of a transfer sharing a document reference', () => {
    const rows = parseStatement(fixture);
    const legs = rows.filter((row) =>
      row.description.includes('withdraw money from savings deposit'),
    );

    expect(legs).toHaveLength(2);
    expect(legs[0]?.dedupKey).not.toBe(legs[1]?.dedupKey);
    expect(legs[0]?.dedupKey).toBe('seb:RO1000000001L01');
    expect(legs[1]?.dedupKey).toBe('seb:RO1000000001L02');
  });

  it('extracts FX metadata from a foreign-currency card purchase', () => {
    const rows = parseStatement(fixture);
    const row = rows.find((r) => r.dedupKey === 'seb:RO1000000004L01');

    expect(row).toMatchObject({
      originalCurrency: 'NOK',
      originalAmountMinorUnits: -29900,
      fxFeeMinorUnits: 68,
      fxFeePercent: 2.65,
    });
  });

  it('leaves FX metadata unset for a row with no embedded original currency', () => {
    const rows = parseStatement(fixture);
    const lidl = rows.find((row) => row.dedupKey === 'seb:RO1000000003L01');

    expect(lidl?.originalCurrency).toBeUndefined();
    expect(lidl?.originalAmountMinorUnits).toBeUndefined();
    expect(lidl?.fxFeeMinorUnits).toBeUndefined();
    expect(lidl?.fxFeePercent).toBeUndefined();
  });

  it('produces the same dedup_key for the same provider transaction id', () => {
    const rowsA = parseStatement(fixture);
    const rowsB = parseStatement(fixture);

    expect(rowsA.map((r) => r.dedupKey)).toEqual(
      rowsB.map((r) => r.dedupKey),
    );
  });
});
