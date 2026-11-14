import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeRows, parseStatement, readSwedbankTable } from './swedbank';

const read = (name: string) =>
  readFileSync(join(__dirname, '__fixtures__', name), 'utf8');
const current = read('swedbank.csv');
const savings = read('swedbank-savings.csv');

const CURRENT_IBAN = 'LT100000000000000003';
const SAVINGS_IBAN = 'LT100000000000000004';

const HEADER =
  '"Sąskaitos Nr.","","Data","Gavėjas","Paaiškinimai","Suma","Valiuta","D/K","Įrašo Nr.","Kodas","Įmokos kodas","Dok. Nr.","Kliento kodas mokėtojo IS","Kliento kodas","Pradinis mokėtojas","Galutinis gavėjas",';
const txRow = (over: { id?: string; dk?: string; amount?: string } = {}) =>
  `"${CURRENT_IBAN}","20","2026-02-03","","Same text","${over.amount ?? '5.00'}","EUR","${over.dk ?? 'D'}","${over.id ?? ''}","K","","","",`;

describe('Swedbank parseStatement', () => {
  it('parses a card purchase, with a negative debit amount', () => {
    const parsed = parseStatement(current);
    const purchase = parsed.rows.find(
      (r) => r.bankTransactionId === '2026012300000002',
    );

    expect(parsed.formatVersion).toBe('swedbank-v1');
    expect(purchase?.normalized).toEqual({
      iban: CURRENT_IBAN,
      postedDate: '2026-01-23',
      amountMinorUnits: -2099,
      currency: 'EUR',
      description:
        'pirkinys 516793******0000 2026.01.21 20.99 eur (000001) shop one vilnius',
      dedupKey: 'swedbank:2026012300000002',
      occurredAt: '2026-01-23T00:00:00Z',
      sourceSeq: 1,
      feeMinorUnits: 0,
    });
    expect(purchase?.normalized?.balanceAfterMinorUnits).toBeUndefined();
    expect(purchase?.normalized?.originalCurrency).toBeUndefined();
  });

  it('treats K as a credit', () => {
    const credit = parseStatement(current).rows.find(
      (r) => r.bankTransactionId === '2026011300000001',
    );
    expect(credit?.normalized?.amountMinorUnits).toBe(25000);
  });

  it('gives every row its own IBAN and currency', () => {
    expect(parseStatement(savings).rows.map((r) => r.iban)).toEqual(
      Array(6).fill(SAVINGS_IBAN),
    );
    expect(
      new Set(parseStatement(current).rows.map((r) => r.currency)),
    ).toEqual(new Set(['EUR']));
  });

  it('emits the raw payload under the original headers, including the unnamed column', () => {
    const first = parseStatement(current).rows[0];

    expect(first?.rowNumber).toBe(1);
    expect(first?.payload['']).toBe('10');
    expect(first?.payload['Paaiškinimai']).toBe('Likutis pradžiai');
    expect(first?.payload['Suma']).toBe('100.00');
    expect(Object.keys(first?.payload ?? {})).toHaveLength(16);
  });

  it('keeps opening, turnover, closing and accrued-interest rows raw-only', () => {
    const cur = parseStatement(current).rows;
    expect(cur.filter((r) => !r.normalized).map((r) => r.payload[''])).toEqual([
      '10',
      '82',
      '82',
      '86',
    ]);
    const sav = parseStatement(savings).rows;
    expect(sav.at(-1)?.payload['']).toBe('900');
    expect(sav.at(-1)?.normalized).toBeUndefined();
    // Posted interest (type 20) is a transaction.
    expect(sav[1]?.normalized?.amountMinorUnits).toBe(150);
  });

  it('accepts a row with trailing cells omitted', () => {
    const short = parseStatement(current).rows.find(
      (r) => r.bankTransactionId === '2026040400000006',
    );
    expect(short?.payload['Dok. Nr.']).toBe('');
    expect(short?.normalized?.amountMinorUnits).toBe(-606);
    expect(short?.payload['Gavėjas']).toBe('SHOP TWO\\MAIN G. 1\\VILNIUS');
  });

  it('keeps commas inside quoted cells', () => {
    const fx = parseStatement(current).rows.find(
      (r) => r.bankTransactionId === '2026030500000005',
    );
    expect(fx?.payload['Paaiškinimai']).toContain('VALIUTOS KURSAS 11.023622,');
    expect(fx?.normalized?.amountMinorUnits).toBe(-1952);
  });

  it('numbers transactions in file order', () => {
    const seqs = parseStatement(current).rows.flatMap((r) =>
      r.normalized ? [r.normalized.sourceSeq] : [],
    );
    expect(seqs).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('reads the declared period and balances', () => {
    const parsed = parseStatement(current);
    expect(parsed.declaredPeriods).toEqual([
      { iban: CURRENT_IBAN, from: '2026-01-01', to: '2026-11-14' },
    ]);
    expect(parsed.declaredBalances).toEqual([
      {
        iban: CURRENT_IBAN,
        openingMinorUnits: 10000,
        closingMinorUnits: 24064,
        turnover: { debitMinorUnits: 16756, creditMinorUnits: 30820 },
      },
    ]);
    // Only a credit turnover row exists in the savings file.
    expect(parseStatement(savings).declaredBalances?.[0]?.turnover).toEqual({
      debitMinorUnits: 0,
      creditMinorUnits: 302,
    });
  });

  it('rejects a file with no closing balance row', () => {
    const without = current
      .split('\r\n')
      .filter((l) => !l.includes('"86"'))
      .join('\r\n');
    expect(() => parseStatement(without)).toThrow(
      /opening \(10\) and one closing/,
    );
    expect(readSwedbankTable(without).malformed[0]?.code).toBe(
      'missing-balance-row',
    );
  });

  it('rejects a row with more cells than the header', () => {
    const table = readSwedbankTable(
      [HEADER, txRow().replace(/,$/, ',"x","x","x","x","x","x",')].join('\r\n'),
    );
    expect(table.malformed.map((m) => m.code)).toContain('malformed-row');
  });
});

describe('Swedbank dedup_key', () => {
  it('uses the record number when present', () => {
    const rows = parseStatement(current).rows.flatMap((r) =>
      r.normalized ? [r.normalized.dedupKey] : [],
    );
    expect(rows.filter((k) => k.startsWith('swedbank:'))).toHaveLength(6);
  });

  it('keeps two identical-looking purchases distinct by record number', () => {
    const keys = parseStatement(current)
      .rows.filter((r) => r.payload['Suma'] === '20.99')
      .map((r) => r.normalized?.dedupKey);
    expect(keys).toEqual([
      'swedbank:2026012300000002',
      'swedbank:2026012300000003',
    ]);
  });

  it('falls back to a hash when the record number is empty, stable across parses', () => {
    const fallback = parseStatement(current).rows.find(
      (r) => r.payload['Gavėjas'] === 'TAX AGENCY',
    );
    expect(fallback?.bankTransactionId).toBeNull();
    expect(fallback?.normalized?.dedupKey).toMatch(/^[0-9a-f]{64}$/);
    expect(
      parseStatement(current).rows.find(
        (r) => r.payload['Gavėjas'] === 'TAX AGENCY',
      )?.normalized?.dedupKey,
    ).toBe(fallback?.normalized?.dedupKey);
  });

  it('ranks identical fallback rows with an occurrence index', () => {
    const rows = [HEADER, txRow(), txRow(), txRow({ id: '777' })].join('\r\n');
    const parsed = parseStatement(
      rows +
        `\r\n"${CURRENT_IBAN}","10","2026-01-01","","Likutis pradžiai","0.00","EUR","K","","AS","","",\r\n"${CURRENT_IBAN}","86","2026-12-31","","Likutis pabaigai","0.00","EUR","K","","LS","","",`,
    );
    const keys = parsed.rows.flatMap((r) =>
      r.normalized ? [r.normalized.dedupKey] : [],
    );
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[2]).toBe('swedbank:777');
  });

  it('rebuilds the same keys from stored payloads', () => {
    const parsed = parseStatement(current);
    const again = normalizeRows(
      parsed.rows.map(({ rowNumber, payload }) => ({ rowNumber, payload })),
      '',
    );
    for (const row of parsed.rows) {
      expect(again.get(row.rowNumber)).toEqual(row.normalized);
    }
  });

  it('never collides across both fixture accounts', () => {
    const keys = [current, savings].flatMap((csv) =>
      parseStatement(csv).rows.flatMap((r) =>
        r.normalized ? [r.normalized.dedupKey] : [],
      ),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});
