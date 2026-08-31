import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeHashDedupKey } from '../dedupKey';
import { parseStatement } from './revolut';

const fixture = readFileSync(
  join(__dirname, '__fixtures__/revolut.csv'),
  'utf8',
);
const uploadAccountIban = 'LT100000000000000099';

describe('Revolut parseStatement', () => {
  it('parses a normal row using the upload-selected account iban', () => {
    const rows = parseStatement(fixture, uploadAccountIban);

    expect(rows[0]).toEqual({
      iban: uploadAccountIban,
      postedDate: '2026-08-29',
      amountMinorUnits: -29,
      currency: 'EUR',
      description: 'lidl',
      dedupKey: computeHashDedupKey(
        {
          iban: uploadAccountIban,
          postedDate: '2026-08-29',
          amountMinorUnits: -29,
          currency: 'EUR',
          normalizedDescription: 'lidl',
        },
        0,
      ),
    });
  });

  it('normalizes description whitespace/casing', () => {
    const rows = parseStatement(fixture, uploadAccountIban);

    expect(rows[0]?.description).toBe('lidl');
  });

  it('assigns increasing occurrence_index to same-file identical-looking rows, both persisted with distinct keys', () => {
    const rows = parseStatement(fixture, uploadAccountIban);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.dedupKey).not.toBe(rows[1]?.dedupKey);
    expect(rows[1]?.dedupKey).toBe(
      computeHashDedupKey(
        {
          iban: uploadAccountIban,
          postedDate: '2026-08-29',
          amountMinorUnits: -29,
          currency: 'EUR',
          normalizedDescription: 'lidl',
        },
        1,
      ),
    );
  });

  it('produces the same dedup_key when the file is parsed twice', () => {
    const rowsA = parseStatement(fixture, uploadAccountIban);
    const rowsB = parseStatement(fixture, uploadAccountIban);

    expect(rowsA.map((r) => r.dedupKey)).toEqual(
      rowsB.map((r) => r.dedupKey),
    );
  });
});
