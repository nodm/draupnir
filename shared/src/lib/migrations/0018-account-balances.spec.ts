// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { applyMigrationsForTest } from './applyMigrationsForTest';
import { m0018 } from './0018-account-balances';
import { MIGRATIONS } from './migrations';

describe('0018-account-balances', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await applyMigrationsForTest(db);
    await db.exec(`
      INSERT INTO accounts (id, bank, iban, currency, display_name, opened_on, opening_balance_minor_units) VALUES
        ('acc1', 'seb', 'IBAN1', 'EUR', 'one', '2024-01-01', 1000);
      INSERT INTO account_members (account_id, user_id, role) VALUES
        ('acc1', 'alice', 'owner'), ('acc1', 'bob', 'viewer');
      INSERT INTO transactions (id, account_id, posted_date, amount_minor_units, currency, description, dedup_key)
        VALUES ('t1', 'acc1', '2024-01-02', 100, 'EUR', 'd', 'k1');
    `);
  }, 60_000);
  afterAll(async () => {
    await db.close();
  });

  async function asApp<T>(sub: string, fn: () => Promise<T>): Promise<T> {
    await db.exec('SET ROLE draupnir_app');
    await db.exec('BEGIN');
    try {
      await db.query(`SELECT set_config('app.sub', $1, true)`, [sub]);
      const result = await fn();
      await db.exec('COMMIT');
      return result;
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    } finally {
      await db.exec('RESET ROLE');
    }
  }

  it('adds nullable balance columns and the order index', async () => {
    const { rows } = await db.query<{
      table_name: string;
      column_name: string;
      is_nullable: string;
    }>(
      `SELECT table_name, column_name, is_nullable FROM information_schema.columns
        WHERE column_name IN ('balance_minor_units', 'balance_as_of', 'balance_reconciled',
                              'occurred_at', 'source_seq', 'running_balance_minor_units')`,
    );
    expect(rows).toHaveLength(6);
    expect(
      rows.map((r) => [r.table_name, r.column_name, r.is_nullable]).sort(),
    ).toEqual([
      ['accounts', 'balance_as_of', 'NO'],
      ['accounts', 'balance_minor_units', 'NO'],
      ['accounts', 'balance_reconciled', 'NO'],
      ['transactions', 'occurred_at', 'YES'],
      ['transactions', 'running_balance_minor_units', 'YES'],
      ['transactions', 'source_seq', 'YES'],
    ]);

    const { rows: indexes } = await db.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'transactions'`,
    );
    expect(indexes.map((i) => i.indexdef)).toContainEqual(
      expect.stringContaining('(account_id, occurred_at, source_seq, id)'),
    );
  });

  it('gives a directly inserted account its opening balance, as of its opening date, reconciled', async () => {
    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT balance_minor_units, CAST(balance_as_of AS text) AS as_of, balance_reconciled
         FROM accounts WHERE id = 'acc1'`,
    );
    expect(rows[0]).toEqual({
      balance_minor_units: 1000,
      as_of: '2024-01-01',
      balance_reconciled: true,
    });
  });

  it('create_account starts the balance at the opening balance', async () => {
    const id = await asApp('carol', async () => {
      const { rows } = await db.query<{ id: string }>(
        `SELECT draupnir.create_account('seb', 'IBAN9', 'EUR', 'nine', '2025-03-01', 2500) AS id`,
      );
      return (rows[0] as { id: string }).id;
    });
    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT balance_minor_units, CAST(balance_as_of AS text) AS as_of, balance_reconciled
         FROM accounts WHERE id = $1`,
      [id],
    );
    expect(rows[0]).toEqual({
      balance_minor_units: 2500,
      as_of: '2025-03-01',
      balance_reconciled: true,
    });
  });

  it('lets an owner update the new columns', async () => {
    const updated = await asApp('alice', async () => {
      const a = await db.query(
        `UPDATE accounts SET balance_minor_units = 1100, balance_as_of = '2024-01-02', balance_reconciled = true WHERE id = 'acc1'`,
      );
      const t = await db.query(
        `UPDATE transactions SET occurred_at = '2024-01-02T10:00:00Z', source_seq = 1, running_balance_minor_units = 1100 WHERE id = 't1'`,
      );
      return [a.affectedRows, t.affectedRows];
    });
    expect(updated).toEqual([1, 1]);
  });

  it('denies a viewer updating the new columns', async () => {
    const updated = await asApp('bob', async () => {
      const a = await db.query(
        `UPDATE accounts SET balance_minor_units = 0 WHERE id = 'acc1'`,
      );
      const t = await db.query(
        `UPDATE transactions SET running_balance_minor_units = 0 WHERE id = 't1'`,
      );
      return [a.affectedRows, t.affectedRows];
    });
    expect(updated).toEqual([0, 0]);
  });
});

describe('0018 on a database that already has accounts', () => {
  it('gives existing accounts their opening balance as an unreconciled placeholder', async () => {
    const db = new PGlite();
    await db.exec(`DO $$ BEGIN CREATE ROLE draupnir_app LOGIN; END $$`);
    for (const migration of MIGRATIONS.filter((m) => m !== m0018)) {
      for (const statement of migration.statements) await db.exec(statement);
    }
    await db.exec(`
      INSERT INTO accounts (id, bank, iban, currency, display_name, opened_on, opening_balance_minor_units)
        VALUES ('old', 'seb', 'IBANOLD', 'EUR', 'old', '2024-05-01', 4200);
    `);

    for (const statement of m0018.statements) await db.exec(statement);

    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT balance_minor_units, CAST(balance_as_of AS text) AS as_of, balance_reconciled
         FROM accounts WHERE id = 'old'`,
    );
    expect(rows[0]).toEqual({
      balance_minor_units: 4200,
      as_of: '2024-05-01',
      balance_reconciled: false,
    });
    await db.close();
  }, 60_000);
});
