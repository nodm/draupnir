import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeHashDedupKey } from '../dedupKey';
import { parseStatement } from './monobank';

const fixture = readFileSync(
  join(__dirname, '__fixtures__/monobank.csv'),
  'utf8',
);
const uploadAccountIban = 'UA100000000000000099';

describe('monobank parseStatement', () => {
  it('parses a normal row using the upload-selected account iban', () => {
    const rows = parseStatement(fixture, uploadAccountIban);

    expect(rows[0]).toEqual({
      iban: uploadAccountIban,
      postedDate: '2026-07-26',
      amountMinorUnits: -20000,
      currency: 'UAH',
      description: 'google',
      dedupKey: computeHashDedupKey(
        {
          iban: uploadAccountIban,
          postedDate: '2026-07-26',
          amountMinorUnits: -20000,
          currency: 'UAH',
          normalizedDescription: 'google',
        },
        0,
      ),
    });
  });

  it('normalizes description whitespace/casing', () => {
    const rows = parseStatement(fixture, uploadAccountIban);

    expect(rows[0]?.description).toBe('google');
  });

  it('assigns increasing occurrence_index to same-file identical-looking rows, both persisted with distinct keys', () => {
    const rows = parseStatement(fixture, uploadAccountIban);
    const lifecellRows = rows.filter((row) =>
      row.description.startsWith('lifecell'),
    );

    expect(lifecellRows).toHaveLength(2);
    expect(lifecellRows[0]?.dedupKey).not.toBe(lifecellRows[1]?.dedupKey);
  });

  it('produces the same dedup_key when the file is parsed twice', () => {
    const rowsA = parseStatement(fixture, uploadAccountIban);
    const rowsB = parseStatement(fixture, uploadAccountIban);

    expect(rowsA.map((r) => r.dedupKey)).toEqual(
      rowsB.map((r) => r.dedupKey),
    );
  });
});
