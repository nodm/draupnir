// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import type { DataApiConfig } from '../dataApi';
import { withCaller } from '../dataApi';
import { applyMigrationsForTest } from '../migrations/applyMigrationsForTest';
import { createPgliteDataApiClient } from '../testing/pgliteDataApiClient';
import { recomputeAccountBalance } from './balances';

const config: DataApiConfig = {
  resourceArn: 'a',
  secretArn: 'a',
  database: 'd',
};

describe('recomputeAccountBalance', () => {
  let db: PGlite;
  let client: RDSDataClient;

  beforeAll(async () => {
    db = new PGlite();
    await applyMigrationsForTest(db);
    client = createPgliteDataApiClient(db, { role: 'draupnir_app' }).client;
  }, 60_000);
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.exec(
      'TRUNCATE transaction_sources, raw_rows, transactions, statement_file_accounts, statement_files, account_members, accounts CASCADE',
    );
    await db.exec(`
      INSERT INTO accounts (id, bank, iban, currency, display_name, opened_on, opening_balance_minor_units)
        VALUES ('acc', 'revolut', 'IBAN', 'EUR', 'a', '2026-01-01', 100000);
      INSERT INTO account_members (account_id, user_id, role) VALUES ('acc', 'u', 'owner');
    `);
  });

  const recompute = () =>
    withCaller(client, config, 'u', (tx) =>
      recomputeAccountBalance(client, config, tx, 'acc'),
    );

  async function addTx(
    id: string,
    amount: number,
    fee: number,
    at: string,
    seq: number,
  ) {
    await db.query(
      `INSERT INTO transactions (id, account_id, posted_date, amount_minor_units, fee_minor_units, currency,
                                 description, dedup_key, occurred_at, source_seq)
       VALUES ($1, 'acc', $2::date, $3, $4, 'EUR', 'd', $1, $5::timestamptz, $6)`,
      [id, at.slice(0, 10), amount, fee, at, seq],
    );
  }

  async function runningBalances() {
    const { rows } = await db.query<{ id: string; b: string | null }>(
      `SELECT id, running_balance_minor_units::text AS b FROM transactions ORDER BY occurred_at, source_seq, id`,
    );
    return rows.map((r) => [r.id, r.b]);
  }

  it('gives an account with no transactions its opening balance as of its opening date', async () => {
    expect(await recompute()).toEqual({
      balanceMinorUnits: 100000,
      balanceAsOf: '2026-01-01',
      reconciled: true,
    });
  });

  it('sums amount minus fee in order and takes the date of the latest occurred_at', async () => {
    await addTx('t2', 10000, 0, '2026-02-03T09:00:00Z', 1);
    await addTx('t1', -3000, 50, '2026-02-02T09:00:00Z', 0);

    const result = await recompute();

    expect(result).toEqual({
      balanceMinorUnits: 106950,
      balanceAsOf: '2026-02-03',
      reconciled: true,
    });
    expect(await runningBalances()).toEqual([
      ['t1', '96950'],
      ['t2', '106950'],
    ]);
  });

  it('orders same-timestamp rows by source_seq', async () => {
    await addTx('b', 500, 0, '2026-02-02T09:00:00Z', 1);
    await addTx('a', -200, 0, '2026-02-02T09:00:00Z', 0);

    await recompute();

    expect(await runningBalances()).toEqual([
      ['a', '99800'],
      ['b', '100300'],
    ]);
  });

  it('is idempotent: a repeat gives the same values and writes no rows', async () => {
    await addTx('t1', -3000, 0, '2026-02-02T09:00:00Z', 0);
    const first = await recompute();
    const second = await recompute();

    expect(second).toEqual(first);
    await db.exec('BEGIN');
    const { affectedRows } = await db.query(
      `UPDATE transactions SET running_balance_minor_units = running_balance_minor_units`,
    );
    await db.exec('ROLLBACK');
    expect(affectedRows).toBe(1);
  });

  it('reports not reconciled when the coverage has a gap', async () => {
    await db.exec(`
      INSERT INTO statement_files (id, upload_account_id, uploaded_by, bank, sha256, s3_key, status) VALUES
        ('f1', 'acc', 'u', 'revolut', 'h1', 'k1', 'approved'),
        ('f2', 'acc', 'u', 'revolut', 'h2', 'k2', 'approved');
      INSERT INTO statement_file_accounts (file_id, account_id, activity_from, activity_to,
                                           opening_balance_minor_units, closing_balance_minor_units) VALUES
        ('f1', 'acc', '2026-01-02', '2026-01-31', 100000, 90000),
        ('f2', 'acc', '2026-03-01', '2026-03-31', 80000, 70000);
    `);

    expect((await recompute()).reconciled).toBe(false);
  });

  it('reports reconciled for connected segments', async () => {
    await db.exec(`
      INSERT INTO statement_files (id, upload_account_id, uploaded_by, bank, sha256, s3_key, status) VALUES
        ('f1', 'acc', 'u', 'revolut', 'h1', 'k1', 'approved'),
        ('f2', 'acc', 'u', 'revolut', 'h2', 'k2', 'approved');
      INSERT INTO statement_file_accounts (file_id, account_id, activity_from, activity_to,
                                           opening_balance_minor_units, closing_balance_minor_units) VALUES
        ('f1', 'acc', '2026-01-02', '2026-01-31', 100000, 90000),
        ('f2', 'acc', '2026-02-01', '2026-02-28', 90000, 70000);
    `);

    expect((await recompute()).reconciled).toBe(true);
  });

  it('throws for an account the caller cannot see', async () => {
    await expect(
      withCaller(client, config, 'stranger', (tx) =>
        recomputeAccountBalance(client, config, tx, 'acc'),
      ),
    ).rejects.toThrow(/Account not found/);
  });
});
