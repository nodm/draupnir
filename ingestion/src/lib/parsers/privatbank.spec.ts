import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeHashDedupKey } from '../dedupKey';
import { parseStatement } from './privatbank';

const read = (name: string) =>
  readFileSync(join(__dirname, '__fixtures__', name), 'utf8');
const uah = read('privatbank-uah.csv');
const eur = read('privatbank-eur.csv');
const IBAN = 'UA100000000000000099';

const normalized = (contents: string) =>
  parseStatement(contents, IBAN).rows.flatMap((r) =>
    r.normalized ? [r.normalized] : [],
  );

describe('privatbank parseStatement', () => {
  it('skips the title line and numbers data rows from 1', () => {
    const { rows, formatVersion, declaredPeriods } = parseStatement(uah, IBAN);

    expect(formatVersion).toBe('privatbank-v1');
    expect(rows).toHaveLength(16);
    expect(rows[0]?.rowNumber).toBe(1);
    expect(rows[0]?.payload['Дата']).toBe('26.10.2026 09:04:41');
    expect(declaredPeriods).toEqual([]);
  });

  it('parses a row in card currency with the upload-selected account', () => {
    const first = normalized(uah)[1];

    expect(first).toEqual({
      iban: IBAN,
      postedDate: '2026-10-02',
      amountMinorUnits: -261093,
      currency: 'UAH',
      description: 'osbb test park, id платежу: 1000000001',
      feeMinorUnits: 0,
      balanceAfterMinorUnits: 3201518,
      occurredAt: '2026-10-02T10:46:47Z',
      sourceSeq: 14,
      dedupKey: computeHashDedupKey(
        {
          iban: IBAN,
          postedDate: '2026-10-02',
          amountMinorUnits: -261093,
          currency: 'UAH',
          normalizedDescription: 'osbb test park, id платежу: 1000000001',
          timeOfDay: '10:46:47',
        },
        0,
      ),
    });
  });

  it('attaches rows of both cards to the selected account', () => {
    const { rows } = parseStatement(uah, IBAN);

    const cards = new Set(rows.map((r) => r.payload['Картка']));
    expect(cards).toEqual(
      new Set(['4000 **** **** 3333', '4000 **** **** 1111']),
    );
    expect(new Set(rows.map((r) => r.iban))).toEqual(new Set([IBAN]));
  });

  it('keeps a foreign-currency transaction as the original amount', () => {
    const pln = normalized(uah).find((r) => r.originalCurrency === 'PLN');

    expect(pln).toMatchObject({
      amountMinorUnits: -440491,
      currency: 'UAH',
      originalCurrency: 'PLN',
      originalAmountMinorUnits: -39512,
    });
  });

  it('has no original amount when the currencies match', () => {
    const rows = normalized(eur);
    expect(rows.every((r) => r.originalCurrency === undefined)).toBe(true);
  });

  it('numbers rows oldest first although the export lists newest first', () => {
    const rows = normalized(uah);
    expect(rows.map((r) => r.sourceSeq)).toEqual(
      rows.map((_, i) => rows.length - 1 - i),
    );
  });

  it('keeps same-second rows distinct and ordered by file position', () => {
    const rows = normalized(uah).filter(
      (r) => r.occurredAt === '2021-11-14T17:56:23Z',
    );

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.dedupKey)).size).toBe(2);
    expect((rows[0] as { sourceSeq: number }).sourceSeq).toBeGreaterThan(
      (rows[1] as { sourceSeq: number }).sourceSeq,
    );
  });

  it('gives identical rows at different times distinct keys', () => {
    const rows = normalized(eur).filter((r) => r.amountMinorUnits === -20000);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.dedupKey).not.toBe(rows[1]?.dedupKey);
  });

  it('gives identical same-second rows occurrence indexes 0 and 1', () => {
    const line =
      '01.01.2026 10:00:00;Перекази;4000 **** **** 3333;Test;-10;UAH;10;UAH;90;UAH';
    const file = [
      'Історія операцій за період 01.01.2026 - 02.01.2026;;;;;;;;;',
      uah.split('\r\n')[1],
      line,
      line.replace(';90;', ';100;'),
    ].join('\r\n');
    const [a, b] = normalized(file);

    expect(a?.dedupKey).not.toBe(b?.dedupKey);
  });

  it('keeps an empty category and a refund', () => {
    const { rows } = parseStatement(uah, IBAN);
    expect(rows.some((r) => r.payload['Категорія'] === '')).toBe(true);
    expect(normalized(eur)[0]?.amountMinorUnits).toBe(20000);
  });

  it('reads balance-after in minor units', () => {
    expect(normalized(eur)[0]?.balanceAfterMinorUnits).toBe(483717);
  });

  it('rejects a file without the title line', () => {
    expect(() =>
      parseStatement(uah.split('\r\n').slice(1).join('\r\n'), IBAN),
    ).toThrow(/title/);
  });
});
