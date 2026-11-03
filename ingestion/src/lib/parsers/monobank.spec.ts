import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeHashDedupKey } from '../dedupKey';
import { parseStatement } from './monobank';

const fixture = readFileSync(
  join(__dirname, '__fixtures__/monobank.csv'),
  'utf8',
);
const uploadAccountIban = 'UA100000000000000099';

const normalized = (contents: string) =>
  parseStatement(contents, uploadAccountIban).rows.flatMap((r) =>
    r.normalized ? [r.normalized] : [],
  );

describe('monobank parseStatement', () => {
  it('parses a normal row using the upload-selected account iban', () => {
    expect(normalized(fixture)[0]).toEqual({
      iban: uploadAccountIban,
      postedDate: '2026-07-26',
      amountMinorUnits: -20000,
      currency: 'UAH',
      description: 'google',
      feeMinorUnits: 0,
      balanceAfterMinorUnits: 253158,
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

  it('keeps the raw payload untouched, including the — placeholder', () => {
    const parsed = parseStatement(fixture, uploadAccountIban);

    expect(parsed.formatVersion).toBe('monobank-v1');
    expect(parsed.rows[0]?.rowNumber).toBe(1);
    expect(parsed.rows[0]?.payload).toMatchObject({
      'Exchange rate': '—',
      'Commission, (UAH)': '—',
      'Card currency amount, (UAH)': '-200.0',
      Balance: '2531.58',
    });
  });

  it('extracts a commission as the fee', () => {
    const header = fixture.split('\n')[0];
    const csv = `${header}\n"26.07.2026 08:48:06",Google,5734,-200.0,-200.0,UAH,—,2.5,—,2531.58\n`;

    expect(normalized(csv)[0]?.feeMinorUnits).toBe(250);
  });

  it('stores a foreign-currency operation in the card currency with the original kept', () => {
    const header = fixture.split('\n')[0];
    const csv = `${header}\n"26.07.2026 08:48:06",Shop,5734,-41.2,-1.0,USD,41.2,—,—,2531.58\n`;
    const [row] = normalized(csv);

    expect(row).toMatchObject({
      amountMinorUnits: -4120,
      currency: 'UAH',
      originalCurrency: 'USD',
      originalAmountMinorUnits: -100,
    });
  });

  it('normalizes description whitespace/casing', () => {
    expect(normalized(fixture)[0]?.description).toBe('google');
  });

  it('assigns increasing occurrence_index to same-file identical-looking rows, both persisted with distinct keys', () => {
    const lifecell = normalized(fixture).filter((row) =>
      row.description.startsWith('lifecell'),
    );

    expect(lifecell).toHaveLength(2);
    expect(lifecell[0]?.dedupKey).not.toBe(lifecell[1]?.dedupKey);
  });

  it('produces the same dedup_key when the file is parsed twice', () => {
    expect(normalized(fixture).map((r) => r.dedupKey)).toEqual(
      normalized(fixture).map((r) => r.dedupKey),
    );
  });

  it('rejects an unknown header', () => {
    expect(() => parseStatement('a,b\n1,2\n', uploadAccountIban)).toThrow(
      /Unrecognized statement format/,
    );
  });
});
