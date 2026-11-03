// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import {
  applyMigrationsForTest,
  createPgliteDataApiClient,
  type DataApiConfig,
} from 'shared';
import type { NormalizedRow } from '../parsers/types';
import { findInFileKeyConflicts, findOverlapConflicts } from './overlap';

const config: DataApiConfig = {
  resourceArn: 'a',
  secretArn: 'a',
  database: 'd',
};

function row(
  rowNumber: number,
  key: string,
  overrides: Partial<NormalizedRow> = {},
) {
  const normalized: NormalizedRow = {
    iban: 'LT000000000000000001',
    postedDate: '2026-08-29',
    amountMinorUnits: -1050,
    currency: 'EUR',
    description: 'lidl',
    dedupKey: key,
    feeMinorUnits: 0,
    ...overrides,
  };
  return { rowNumber, normalized };
}

describe('findOverlapConflicts', () => {
  let db: PGlite;
  let client: ReturnType<typeof createPgliteDataApiClient>['client'];

  beforeAll(async () => {
    db = new PGlite();
    await applyMigrationsForTest(db);
    await db.exec(`
      INSERT INTO accounts (id, bank, iban, currency, display_name, opened_on, opening_balance_minor_units) VALUES
        ('A', 'seb', 'LT000000000000000001', 'EUR', 'A', '2024-01-01', 0),
        ('B', 'seb', 'LT000000000000000002', 'EUR', 'B', '2024-01-01', 0);
      INSERT INTO transactions (account_id, posted_date, amount_minor_units, currency, description, dedup_key, balance_after_minor_units) VALUES
        ('A', '2026-08-29', -1050, 'EUR', 'lidl', 'k1', 5000),
        ('B', '2026-08-29', -9999, 'EUR', 'other', 'k1', NULL);
    `);
    client = createPgliteDataApiClient(db, { role: 'draupnir_app' }).client;
  });
  afterAll(async () => {
    await db.close();
  });

  it('accepts overlapping rows that match what is stored', async () => {
    const found = await findOverlapConflicts(client, config, 'tx', 'A', [
      row(1, 'k1', { balanceAfterMinorUnits: 5000 }),
    ]);

    expect(found).toEqual([]);
  });

  it('accepts rows with no stored counterpart', async () => {
    expect(
      await findOverlapConflicts(client, config, 'tx', 'A', [row(1, 'new')]),
    ).toEqual([]);
  });

  it('rejects a different amount, naming the row and the stored date and amount', async () => {
    const found = await findOverlapConflicts(client, config, 'tx', 'A', [
      row(3, 'k1', { amountMinorUnits: -900, balanceAfterMinorUnits: 5000 }),
    ]);

    expect(found).toEqual([
      expect.objectContaining({
        code: 'conflicting-overlap',
        row: 3,
        message: expect.stringMatching(
          /Row 3.*-9\.00 EUR.*2026-08-29, -10\.50 EUR/,
        ),
      }),
    ]);
  });

  it.each([
    ['posted date', { postedDate: '2026-08-30' }],
    ['currency', { currency: 'USD' }],
    ['fee', { feeMinorUnits: 5 }],
    ['balance after', { balanceAfterMinorUnits: 4000 }],
  ])('rejects a different %s', async (_name, change) => {
    const found = await findOverlapConflicts(client, config, 'tx', 'A', [
      row(1, 'k1', { balanceAfterMinorUnits: 5000, ...change }),
    ]);

    expect(found).toHaveLength(1);
  });

  it('only compares against the same account, never another account with the same key', async () => {
    const found = await findOverlapConflicts(client, config, 'tx', 'B', [
      row(1, 'k1', { amountMinorUnits: -9999, description: 'other' }),
    ]);

    expect(found).toEqual([]);
  });
});

describe('findInFileKeyConflicts', () => {
  it('allows the same key with identical values', () => {
    expect(findInFileKeyConflicts([row(1, 'k'), row(2, 'k')])).toEqual([]);
  });

  it('rejects the same key with different values', () => {
    expect(
      findInFileKeyConflicts([
        row(1, 'k'),
        row(2, 'k', { amountMinorUnits: 5 }),
      ]),
    ).toEqual([
      expect.objectContaining({
        code: 'conflicting-duplicate-in-file',
        row: 2,
      }),
    ]);
  });
});
