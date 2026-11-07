import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStatement as parseSeb } from './seb';

const parseStatement = parseSeb;
const normalizedRows = (contents: string) =>
  parseSeb(contents).rows.flatMap((row) =>
    row.normalized ? [row.normalized] : [],
  );

const fixture = readFileSync(join(__dirname, '__fixtures__/seb.csv'), 'utf8');

const TITLE_LINE =
  '"SĄSKAITOS  (LT100000000000000001) IŠRAŠAS (UŽ LAIKOTARPĮ: 2026-08-29-2026-08-29)";';
const HEADER_LINE =
  '"DOK NR.";"DATA";"VALIUTA";"SUMA";"MOKĖTOJO ARBA GAVĖJO PAVADINIMAS";"MOKĖTOJO ARBA GAVĖJO IDENTIFIKACINIS KODAS";"SĄSKAITA";"KREDITO ĮSTAIGOS PAVADINIMAS";"KREDITO ĮSTAIGOS SWIFT KODAS";"MOKĖJIMO PASKIRTIS";"TRANSAKCIJOS KODAS";"DOKUMENTO DATA";"TRANSAKCIJOS TIPAS";"NUORODA";"DEBETAS/KREDITAS";"SUMA SĄSKAITOS VALIUTA";"SĄSKAITOS NR";"SĄSKAITOS VALIUTA";';

function dataRow(debitCredit: string, transakcijosKodas = 'RO1L01'): string {
  return `"CLR1";2026-08-29;"EUR";22,23;"IKI EUROPA";"";"";"AB SEB BANKAS";"CBVILT2X";"purpose text";"${transakcijosKodas}";2026-08-28;"PMNTCCRDOTHR";"";"${debitCredit}";22,23;"LT100000000000000002";"EUR";`;
}

describe('SEB parseStatement', () => {
  it('parses a normal row', () => {
    const rows = normalizedRows(fixture);
    const lidl = rows.find((row) => row.dedupKey === 'seb:RO1000000003L01');

    expect(lidl).toEqual({
      iban: 'LT100000000000000002',
      postedDate: '2026-08-29',
      amountMinorUnits: -6488,
      currency: 'EUR',
      description:
        '28/08/2026 19:17 kortelė...000000 lidl/60175 lidl zalgir/vilnius/ltu #869452, dok. nr. clr10000001, operacijos nr. ro1000000003l01',
      dedupKey: 'seb:RO1000000003L01',
      feeMinorUnits: 0,
      occurredAt: '2026-08-29T00:00:00Z',
      sourceSeq: 2,
    });
    expect(lidl?.balanceAfterMinorUnits).toBeUndefined();
  });

  it('emits the raw payload with the original cell strings, row number and format version', () => {
    const parsed = parseSeb(fixture);
    const first = parsed.rows[0];

    expect(parsed.formatVersion).toBe('seb-v1');
    expect(first?.rowNumber).toBe(1);
    expect(first?.payload['SUMA']).toBe('50,00');
    expect(first?.payload['DATA']).toBe('2026-08-29');
    expect(first?.bankTransactionId).toBe('RO1000000001L01');
    expect(first?.iban).toBe('LT100000000000000002');
  });

  it('numbers data rows 1..n in file order, skipping title and header lines', () => {
    const parsed = parseSeb(fixture);

    expect(parsed.rows.map((r) => r.rowNumber)).toEqual(
      parsed.rows.map((_, i) => i + 1),
    );
  });

  it('reads the declared period from each account title line', () => {
    const parsed = parseSeb(fixture);

    // Attributed to the IBANs of each block's own rows.
    expect(parsed.declaredPeriods).toEqual(
      expect.arrayContaining([
        { iban: 'LT100000000000000002', from: '2026-08-29', to: '2026-08-29' },
        { iban: 'LT100000000000000001', from: '2026-08-29', to: '2026-08-29' },
      ]),
    );
  });

  it('normalizes description whitespace/casing', () => {
    const rows = normalizedRows(fixture);
    const row = rows.find((r) => r.dedupKey === 'seb:RD300000001');

    expect(row?.description).toBe(row?.description.trim().toLowerCase());
    expect(row?.description).not.toMatch(/[A-Z]/);
  });

  it('produces rows for both IBANs in a file spanning two accounts', () => {
    const rows = normalizedRows(fixture);
    const ibans = new Set(rows.map((row) => row.iban));

    expect(ibans).toEqual(
      new Set(['LT100000000000000002', 'LT100000000000000001']),
    );
  });

  it('does not collide two legs of a transfer sharing a document reference', () => {
    const rows = normalizedRows(fixture);
    const legs = rows.filter((row) =>
      row.description.includes('withdraw money from savings deposit'),
    );

    expect(legs).toHaveLength(2);
    expect(legs[0]?.dedupKey).not.toBe(legs[1]?.dedupKey);
    expect(legs[0]?.dedupKey).toBe('seb:RO1000000001L01');
    expect(legs[1]?.dedupKey).toBe('seb:RO1000000001L02');
  });

  it('extracts FX metadata from a foreign-currency card purchase', () => {
    const rows = normalizedRows(fixture);
    const row = rows.find((r) => r.dedupKey === 'seb:RO1000000004L01');

    expect(row).toMatchObject({
      originalCurrency: 'NOK',
      originalAmountMinorUnits: -29900,
      fxFeeMinorUnits: 68,
      fxFeePercent: 2.65,
    });
  });

  it('leaves FX metadata unset for a row with no embedded original currency', () => {
    const rows = normalizedRows(fixture);
    const lidl = rows.find((row) => row.dedupKey === 'seb:RO1000000003L01');

    expect(lidl?.originalCurrency).toBeUndefined();
    expect(lidl?.originalAmountMinorUnits).toBeUndefined();
    expect(lidl?.fxFeeMinorUnits).toBeUndefined();
    expect(lidl?.fxFeePercent).toBeUndefined();
  });

  it('throws on a row with an unrecognized DEBETAS/KREDITAS marker', () => {
    const malformed = [TITLE_LINE, HEADER_LINE, dataRow('X')].join('\n');

    expect(() => parseStatement(malformed)).toThrow(
      /Unrecognized DEBETAS\/KREDITAS marker/,
    );
  });

  it('throws on a row with the wrong field count instead of dropping it', () => {
    const truncatedRow = dataRow('D').replace(/;"EUR";$/, ';');
    const malformed = [TITLE_LINE, HEADER_LINE, truncatedRow].join('\n');

    expect(() => parseStatement(malformed)).toThrow(/Malformed SEB row/);
  });

  it('throws on a truncated row that happens to have 2 fields, instead of treating it as a title', () => {
    const malformed = [TITLE_LINE, HEADER_LINE, '"DP1000001";2026-08-29'].join(
      '\n',
    );

    expect(() => parseStatement(malformed)).toThrow(/Malformed SEB row/);
  });

  it('throws on a row with an empty TRANSAKCIJOS KODAS instead of building a degenerate dedup_key', () => {
    const malformed = [TITLE_LINE, HEADER_LINE, dataRow('D', '')].join('\n');

    expect(() => parseStatement(malformed)).toThrow(/empty TRANSAKCIJOS KODAS/);
  });

  it('orders same-day rows by file position', () => {
    const file = [
      TITLE_LINE,
      HEADER_LINE,
      dataRow('D', 'RO1'),
      dataRow('C', 'RO2'),
      dataRow('D', 'RO3'),
    ].join('\n');

    expect(normalizedRows(file).map((r) => [r.dedupKey, r.sourceSeq])).toEqual([
      ['seb:RO1', 0],
      ['seb:RO2', 1],
      ['seb:RO3', 2],
    ]);
    expect(new Set(normalizedRows(file).map((r) => r.occurredAt))).toEqual(
      new Set(['2026-08-29T00:00:00Z']),
    );
  });

  it('produces the same dedup_key for the same provider transaction id', () => {
    const rowsA = normalizedRows(fixture);
    const rowsB = normalizedRows(fixture);

    expect(rowsA.map((r) => r.dedupKey)).toEqual(rowsB.map((r) => r.dedupKey));
  });
});
