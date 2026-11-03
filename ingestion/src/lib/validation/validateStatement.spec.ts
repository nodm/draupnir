import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateStatementFile } from './validateStatement';

const fixtureDir = join(__dirname, '../parsers/__fixtures__');
const read = (name: string) => readFileSync(join(fixtureDir, name), 'utf8');
const seb = read('seb.csv');
const revolut = read('revolut.csv');
const monobank = read('monobank.csv');
const IBAN = 'LT100000000000000099';

function reasons(result: ReturnType<typeof validateStatementFile>) {
  if (result.ok) throw new Error('expected a rejection');
  return result.reasons;
}

describe('validateStatementFile — formats', () => {
  it('approves each bank fixture', () => {
    expect(validateStatementFile('seb', seb, IBAN).ok).toBe(true);
    expect(validateStatementFile('revolut', revolut, IBAN).ok).toBe(true);
    expect(validateStatementFile('monobank', monobank, IBAN).ok).toBe(true);
  });

  it('rejects an unknown header as an unrecognized format', () => {
    const result = validateStatementFile('revolut', 'Foo,Bar\n1,2\n', IBAN);

    expect(reasons(result)).toEqual([
      expect.objectContaining({ code: 'unrecognized-format' }),
    ]);
  });

  it("rejects another bank's export", () => {
    const result = validateStatementFile('revolut', monobank, IBAN);

    expect(reasons(result)[0]?.code).toBe('unrecognized-format');
  });

  it('rejects a duplicate column header, naming the column', () => {
    const csv = revolut.replace('Fee,Currency', 'Fee,Fee');
    const result = validateStatementFile('revolut', csv, IBAN);

    expect(reasons(result)).toEqual([
      expect.objectContaining({
        code: 'duplicate-header',
        message: expect.stringContaining('Fee'),
      }),
    ]);
  });

  it('rejects an empty file', () => {
    expect(reasons(validateStatementFile('revolut', '', IBAN))[0]?.code).toBe(
      'unrecognized-format',
    );
  });

  it('rejects a header-only file', () => {
    const header = revolut.split('\n')[0];

    expect(
      reasons(validateStatementFile('revolut', `${header}\n`, IBAN))[0]?.code,
    ).toBe('no-rows');
  });

  it('rejects unterminated quoting as malformed csv', () => {
    const csv = `${revolut}Card Payment,"Current,2026\n`;

    expect(reasons(validateStatementFile('revolut', csv, IBAN))[0]?.code).toBe(
      'malformed-csv',
    );
  });
});

describe('validateStatementFile — row validation', () => {
  it('collects every bad row, with row numbers, rather than stopping at the first', () => {
    const lines = revolut.trimEnd().split('\n');
    const csv = [
      lines[0],
      lines[1]?.replace(',-0.29,', ',abc,'),
      lines[2]?.replace('2026-08-28 19:20:23', 'yesterday'),
    ].join('\n');

    const found = reasons(validateStatementFile('revolut', csv, IBAN));

    expect(found.map((r) => r.row)).toEqual([1, 2]);
    expect(found[0]?.message).toMatch(/Row 1, Amount/);
    expect(found[1]?.message).toMatch(/Row 2, Started Date/);
  });

  it('one bad row among many rejects the whole file and names the row', () => {
    const header = revolut.split('\n')[0];
    const good =
      'Card Payment,Current,2026-08-28 19:20:23,2026-08-29 12:23:37,Lidl,0.00,0.00,EUR,COMPLETED,10.00';
    const body = Array.from({ length: 200 }, () => good);
    body.push(good.replace(',0.00,0.00,EUR', ',12x,0.00,EUR'));

    const result = validateStatementFile(
      'revolut',
      [header, ...body].join('\n'),
      IBAN,
    );

    expect(reasons(result)).toEqual([
      expect.objectContaining({ code: 'invalid-cell', row: 201 }),
    ]);
  });

  it('does not require a balance or completion date on a PENDING row', () => {
    const header = revolut.split('\n')[0];
    const csv = `${header}\nCard Payment,Current,2026-08-29 09:00:00,,Coffee,-3.50,0.00,EUR,PENDING,\n`;

    expect(validateStatementFile('revolut', csv, IBAN).ok).toBe(true);
  });

  it('requires a balance on a COMPLETED row', () => {
    const header = revolut.split('\n')[0];
    const csv = `${header}\nCard Payment,Current,2026-08-29 09:00:00,2026-08-29 09:01:00,Coffee,-3.50,0.00,EUR,COMPLETED,\n`;

    expect(
      reasons(validateStatementFile('revolut', csv, IBAN))[0]?.message,
    ).toMatch(/Balance/);
  });

  it('rejects a SEB row with an unrecognized debit/credit marker', () => {
    const csv = seb.replace(';"D";50,00;', ';"X";50,00;');

    const found = reasons(validateStatementFile('seb', csv, IBAN));

    expect(found[0]?.message).toMatch(/DEBETAS\/KREDITAS/);
    expect(found[0]?.row).toBe(1);
  });

  it('rejects an impossible calendar date instead of rolling it over', () => {
    const sebCsv = seb.replace(
      '2026-08-29;"EUR";50,00',
      '2026-02-31;"EUR";50,00',
    );
    const revolutCsv = revolut.replace(
      '2026-08-28 19:20:23',
      '2026-02-30 19:20:23',
    );
    const monoCsv = monobank.replace(
      '26.07.2026 08:48:06',
      '31.04.2026 08:48:06',
    );

    expect(
      reasons(validateStatementFile('seb', sebCsv, IBAN))[0]?.message,
    ).toMatch(/DATA is not a real calendar date/);
    expect(
      reasons(validateStatementFile('revolut', revolutCsv, IBAN))[0]?.message,
    ).toMatch(/Started Date is not a real calendar date/);
    expect(
      reasons(validateStatementFile('monobank', monoCsv, IBAN))[0]?.message,
    ).toMatch(/Date and time is not a real calendar date/);
  });

  it('accepts a real leap day', () => {
    const csv = revolut.replace('2026-08-28 19:20:23', '2028-02-29 19:20:23');

    expect(validateStatementFile('revolut', csv, IBAN).ok).toBe(true);
  });

  it('keeps earlier SEB row reasons when the header is also bad', () => {
    const csv =
      seb.replace('"DOK NR.";"DATA"', '"DOK NR.";"DATA2"') + '"x";1\n';

    const found = reasons(validateStatementFile('seb', csv, IBAN));

    expect(found.map((r) => r.code)).toEqual([
      'malformed-row',
      'unrecognized-format',
    ]);
  });

  it('rejects a SEB row with the wrong field count', () => {
    const csv = `${seb}"DP1";2026-08-29\n`;

    const found = reasons(validateStatementFile('seb', csv, IBAN));

    expect(found.at(-1)?.code).toBe('malformed-row');
  });

  it('rejects a SEB row with an empty TRANSAKCIJOS KODAS', () => {
    const csv = seb.replace('"RO1000000001L01"', '""');

    expect(
      reasons(validateStatementFile('seb', csv, IBAN)).some((r) =>
        /TRANSAKCIJOS KODAS/.test(r.message),
      ),
    ).toBe(true);
  });

  it('rejects a monobank row with a non-numeric balance', () => {
    const csv = monobank.replace('2531.58', 'n/a');

    expect(
      reasons(validateStatementFile('monobank', csv, IBAN))[0]?.message,
    ).toMatch(/Balance/);
  });
});

describe('validateStatementFile — balance chain', () => {
  const header = revolut.split('\n')[0];
  const row = (
    completed: string,
    amount: string,
    fee: string,
    balance: string,
    state = 'COMPLETED',
    product = 'Current',
  ) =>
    `Card Payment,${product},2026-08-28 10:00:00,${completed},Shop,${amount},${fee},EUR,${state},${balance}`;

  it('passes a consistent chain (11.62 then 11.33)', () => {
    const result = validateStatementFile('revolut', revolut, IBAN);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.balances.get(IBAN)).toEqual({
        // 11.62 before the first row's -0.29
        openingBalanceMinorUnits: 1191,
        closingBalanceMinorUnits: 1133,
      });
    }
  });

  it('rejects a broken chain with the row number and expected/actual balances', () => {
    const csv = [
      header,
      row('2026-08-29 10:00:00', '-1.00', '0.00', '10.00'),
      row('2026-08-29 11:00:00', '-1.00', '0.00', '8.50'),
    ].join('\n');

    const found = reasons(validateStatementFile('revolut', csv, IBAN));

    expect(found).toEqual([
      expect.objectContaining({
        code: 'balance-chain-broken',
        row: 2,
        message: expect.stringMatching(/8\.50.*expected 9\.00/),
      }),
    ]);
  });

  it('subtracts the fee', () => {
    const csv = [
      header,
      row('2026-08-29 10:00:00', '-1.00', '0.00', '10.00'),
      row('2026-08-29 11:00:00', '-1.00', '0.25', '8.75'),
    ].join('\n');

    expect(validateStatementFile('revolut', csv, IBAN).ok).toBe(true);
  });

  it('skips PENDING / DECLINED rows between two COMPLETED rows', () => {
    const csv = [
      header,
      row('2026-08-29 10:00:00', '-1.00', '0.00', '10.00'),
      row('', '-50.00', '0.00', '', 'PENDING'),
      row('', '-9.00', '0.00', '', 'DECLINED'),
      row('2026-08-29 11:00:00', '-1.00', '0.00', '9.00'),
    ].join('\n');

    expect(validateStatementFile('revolut', csv, IBAN).ok).toBe(true);
  });

  it('skips non-Current product rows', () => {
    const csv = [
      header,
      row('2026-08-29 10:00:00', '-1.00', '0.00', '10.00'),
      row(
        '2026-08-29 10:30:00',
        '5.00',
        '0.00',
        '105.00',
        'COMPLETED',
        'Savings',
      ),
      row('2026-08-29 11:00:00', '-1.00', '0.00', '9.00'),
    ].join('\n');

    expect(validateStatementFile('revolut', csv, IBAN).ok).toBe(true);
  });

  it('walks Revolut rows in Completed Date order, not file order', () => {
    const csv = [
      header,
      row('2026-08-29 11:00:00', '-1.00', '0.00', '9.00'),
      row('2026-08-29 10:00:00', '-1.00', '0.00', '10.00'),
    ].join('\n');

    expect(validateStatementFile('revolut', csv, IBAN).ok).toBe(true);
  });

  it('walks monobank newest-first rows in reverse', () => {
    const result = validateStatementFile('monobank', monobank, IBAN);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.balances.get(IBAN)).toEqual({
        openingBalanceMinorUnits: 375158, // 3741.58 + 10.00 before the oldest row
        closingBalanceMinorUnits: 253158,
      });
    }
  });

  it('rejects a broken monobank chain', () => {
    const csv = monobank.replace('2731.58', '2700.00');

    const found = reasons(validateStatementFile('monobank', csv, IBAN));

    expect(found.some((r) => r.code === 'balance-chain-broken')).toBe(true);
  });

  it('skips the chain for SEB and reports no balances', () => {
    const result = validateStatementFile('seb', seb, IBAN);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.balances.size).toBe(0);
  });
});
