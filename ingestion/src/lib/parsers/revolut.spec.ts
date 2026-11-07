import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeHashDedupKey } from '../dedupKey';
import { parseStatement } from './revolut';

const read = (name: string) =>
  readFileSync(join(__dirname, '__fixtures__', name), 'utf8');
const fixture = read('revolut.csv');
const states = read('revolut-states.csv');
const uploadAccountIban = 'LT100000000000000099';

const normalized = (contents: string) =>
  parseStatement(contents, uploadAccountIban).rows.flatMap((r) =>
    r.normalized ? [r.normalized] : [],
  );

describe('Revolut parseStatement', () => {
  it('parses a normal row using the upload-selected account iban and Started Date', () => {
    const [first] = normalized(fixture);

    expect(first).toEqual({
      iban: uploadAccountIban,
      // Started Date (2026-08-28), not Completed Date (2026-08-29).
      postedDate: '2026-08-28',
      amountMinorUnits: -29,
      currency: 'EUR',
      description: 'lidl',
      feeMinorUnits: 0,
      balanceAfterMinorUnits: 1162,
      // Completed Date, read as UTC; the first of the two rows completed together.
      occurredAt: '2026-08-29T12:23:37Z',
      sourceSeq: 0,
      dedupKey: computeHashDedupKey(
        {
          iban: uploadAccountIban,
          postedDate: '2026-08-28',
          amountMinorUnits: -29,
          currency: 'EUR',
          normalizedDescription: 'lidl',
        },
        0,
      ),
    });
  });

  describe('order key', () => {
    const header =
      'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance';

    it('orders by completion time, not start, ranking ties in file order', () => {
      const file = [
        header,
        'Card Payment,Current,2026-08-28 19:00:00,2026-08-29 10:00:00,B,-1.00,0.00,EUR,COMPLETED,9.00',
        'Card Payment,Current,2026-08-29 08:00:00,2026-08-29 09:00:00,A,-1.00,0.00,EUR,COMPLETED,8.00',
        'Card Payment,Current,2026-08-29 08:30:00,2026-08-29 10:00:00,C,-1.00,0.00,EUR,COMPLETED,7.00',
      ].join('\n');

      expect(normalized(file).map((r) => [r.description, r.sourceSeq])).toEqual(
        [
          ['b', 1],
          ['a', 0],
          ['c', 2],
        ],
      );
    });

    it('keeps a row that started one day and completed the next on the completion day', () => {
      const [row] = normalized(fixture);

      expect(row?.postedDate).toBe('2026-08-28');
      expect(row?.occurredAt.slice(0, 10)).toBe('2026-08-29');
    });
  });

  it('extracts fee and balance-after in minor units', () => {
    const rows = normalized(states);

    expect(rows[1]).toMatchObject({
      amountMinorUnits: -29,
      feeMinorUnits: 10,
      balanceAfterMinorUnits: 1123,
    });
  });

  it('emits the raw payload with original cell strings, row number and format version', () => {
    const parsed = parseStatement(fixture, uploadAccountIban);

    expect(parsed.formatVersion).toBe('revolut-v1');
    expect(parsed.rows[1]?.rowNumber).toBe(2);
    expect(parsed.rows[1]?.payload).toMatchObject({
      Fee: '0.00',
      Balance: '11.33',
      'Completed Date': '2026-08-29 12:23:37',
    });
    expect(parsed.rows[0]?.bankTransactionId).toBeNull();
  });

  it('normalizes description whitespace/casing', () => {
    expect(normalized(fixture)[0]?.description).toBe('lidl');
  });

  it('assigns increasing occurrence_index to same-file identical-looking rows, both persisted with distinct keys', () => {
    const rows = normalized(fixture);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.dedupKey).not.toBe(rows[1]?.dedupKey);
    expect(rows[1]?.dedupKey).toBe(
      computeHashDedupKey(
        {
          iban: uploadAccountIban,
          postedDate: '2026-08-28',
          amountMinorUnits: -29,
          currency: 'EUR',
          normalizedDescription: 'lidl',
        },
        1,
      ),
    );
  });

  it('produces the same dedup_key when the file is parsed twice', () => {
    expect(normalized(fixture).map((r) => r.dedupKey)).toEqual(
      normalized(fixture).map((r) => r.dedupKey),
    );
  });

  it('keeps PENDING and non-Current rows raw-only', () => {
    const parsed = parseStatement(states, uploadAccountIban);

    expect(parsed.rows).toHaveLength(4);
    expect(parsed.rows.map((r) => r.normalized !== undefined)).toEqual([
      true,
      false,
      true,
      false,
    ]);
    expect(parsed.rows[1]?.payload['State']).toBe('PENDING');
    expect(parsed.rows[3]?.payload['Product']).toBe('Savings');
  });

  it('keeps the dedup_key when a pending transaction later completes with a new Completed Date', () => {
    const header = read('revolut.csv').split('\n')[0];
    const early = `${header}\nCard Payment,Current,2026-08-28 19:20:23,2026-08-29 12:23:37,Lidl,-0.29,0.00,EUR,COMPLETED,11.62\n`;
    const late = `${header}\nCard Payment,Current,2026-08-28 19:20:23,2026-09-01 08:00:00,Lidl,-0.29,0.00,EUR,COMPLETED,11.62\n`;

    expect(normalized(late)[0]?.dedupKey).toBe(normalized(early)[0]?.dedupKey);
  });

  it('rejects an unknown header', () => {
    expect(() => parseStatement('a,b\n1,2\n', uploadAccountIban)).toThrow(
      /Unrecognized statement format/,
    );
  });
});
