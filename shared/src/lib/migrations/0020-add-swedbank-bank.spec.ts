// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { applyMigrationsForTest } from './applyMigrationsForTest';
import { MIGRATIONS } from './migrations';
import { m0020 } from './0020-add-swedbank-bank';

const insertAccount = (db: PGlite, id: string, bank: string) =>
  db.query(
    `INSERT INTO accounts (id, bank, iban, currency, display_name, opened_on, opening_balance_minor_units)
     VALUES ($1, $2, $1, 'EUR', $1, '2024-01-01', 0)`,
    [id, bank],
  );

describe('0020-add-swedbank-bank', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await applyMigrationsForTest(db);
  }, 60_000);
  afterAll(async () => {
    await db.close();
  });

  it('is registered last', () => {
    expect(MIGRATIONS[MIGRATIONS.length - 1]).toBe(m0020);
  });

  it('accepts every supported bank', async () => {
    for (const bank of ['seb', 'revolut', 'monobank', 'swedbank']) {
      await insertAccount(db, `ok-${bank}`, bank);
    }
    const { rows } = await db.query<{ bank: string }>(
      `SELECT bank FROM accounts WHERE id LIKE 'ok-%' ORDER BY id`,
    );
    expect(rows.map((r) => r.bank)).toEqual([
      'monobank',
      'revolut',
      'seb',
      'swedbank',
    ]);
  });

  it('rejects an unknown bank', async () => {
    await expect(insertAccount(db, 'bad', 'nordea')).rejects.toThrow();
  });
});
