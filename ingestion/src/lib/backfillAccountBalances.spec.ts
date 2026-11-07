// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { S3Client } from '@aws-sdk/client-s3';
import {
  applyMigrationsForTest,
  createPgliteDataApiClient,
  type DataApiConfig,
} from 'shared';
import { backfillAccountBalances } from './backfillAccountBalances';
import { processStatementFile } from './processStatementFile';
import { RebuildAccountNotFoundError } from './rebuildAccount';

const config: DataApiConfig = {
  resourceArn: 'a',
  secretArn: 'a',
  database: 'd',
};
const REVOLUT = readFileSync(
  join(__dirname, 'parsers/__fixtures__/revolut.csv'),
  'utf8',
);
const HEADER = REVOLUT.split('\n')[0] as string;
const row = (day: string, description: string, balance: string) =>
  `Card Payment,Current,2026-01-${day} 10:00:00,2026-01-${day} 10:00:00,${description},-1.00,0.00,EUR,COMPLETED,${balance}`;

describe('backfillAccountBalances', () => {
  let db: PGlite;
  let client: ReturnType<typeof createPgliteDataApiClient>['client'];
  let counter = 0;

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
      'TRUNCATE transaction_sources, transactions, raw_rows, statement_file_accounts, statement_files, account_members, accounts CASCADE',
    );
    await db.exec(`
      INSERT INTO accounts (id, bank, iban, currency, display_name, opened_on, opening_balance_minor_units)
        VALUES ('R', 'revolut', 'LT100000000000000077', 'EUR', 'R', '2026-01-01', 1000);
      INSERT INTO account_members (account_id, user_id, role) VALUES ('R', 'user-1', 'owner');
    `);
  });

  async function upload(contents: string) {
    counter += 1;
    const bytes = Buffer.from(contents, 'utf8');
    const s3 = {
      send: async () => ({
        Body: { transformToByteArray: async () => new Uint8Array(bytes) },
        ContentLength: bytes.length,
      }),
    } as unknown as S3Client;
    return processStatementFile(
      client,
      config,
      s3,
      'bucket',
      `uploads/user-1/R/${counter}.csv`,
      bytes.length,
    );
  }

  const stored = async () =>
    (
      await db.query<Record<string, unknown>>(
        `SELECT id, dedup_key, occurred_at::text AS occurred_at, source_seq,
                running_balance_minor_units::text AS running
           FROM transactions ORDER BY dedup_key`,
      )
    ).rows;
  const accountRow = async () =>
    (
      await db.query<Record<string, unknown>>(
        `SELECT balance_minor_units::text AS balance, balance_as_of::text AS as_of, balance_reconciled
           FROM accounts WHERE id = 'R'`,
      )
    ).rows[0];

  // The state of prod before this change: rows and files exist, the new
  // transaction columns are empty and accounts hold the migration's placeholder.
  async function clearNewColumns() {
    await db.exec(`
      UPDATE transactions SET occurred_at = NULL, source_seq = NULL, running_balance_minor_units = NULL;
      UPDATE accounts SET balance_minor_units = opening_balance_minor_units,
                          balance_as_of = opened_on, balance_reconciled = false;
    `);
  }

  async function seedTwoFiles() {
    await upload([HEADER, row('02', 'Alpha', '9.00')].join('\n'));
    await upload([HEADER, row('03', 'Bravo', '8.00')].join('\n'));
  }

  it('fills the order keys, running balances and balance, keeping every row id', async () => {
    await seedTwoFiles();
    const expected = await stored();
    const expectedAccount = await accountRow();
    const sources = await db.query('SELECT * FROM transaction_sources');
    await clearNewColumns();

    const result = await backfillAccountBalances(client, config, 'user-1', 'R');

    expect(await stored()).toEqual(expected);
    expect(await accountRow()).toEqual(expectedAccount);
    expect((await db.query('SELECT * FROM transaction_sources')).rows).toEqual(
      sources.rows,
    );
    expect(result).toMatchObject({
      accountId: 'R',
      balanceMinorUnits: 800,
      balanceAsOf: '2026-01-03',
      reconciled: true,
      transactions: 2,
      withoutOrderKey: 0,
    });
  });

  it('changes nothing on a second run', async () => {
    await seedTwoFiles();
    await clearNewColumns();
    await backfillAccountBalances(client, config, 'user-1', 'R');
    const versions = () =>
      db.query<{ id: string; xmin: string }>(
        'SELECT id, xmin::text AS xmin FROM transactions ORDER BY id',
      );
    const before = await versions();
    const beforeAccount = await accountRow();

    await backfillAccountBalances(client, config, 'user-1', 'R');

    expect((await versions()).rows).toEqual(before.rows);
    expect(await accountRow()).toEqual(beforeAccount);
  });

  it('reports an account whose coverage has a gap as not reconciled', async () => {
    await seedTwoFiles();
    await clearNewColumns();
    // A legacy gap: the second file no longer opens at the first one's close.
    await db.exec(
      `UPDATE statement_file_accounts SET opening_balance_minor_units = 5000
        WHERE activity_from = '2026-01-03'`,
    );

    const result = await backfillAccountBalances(client, config, 'user-1', 'R');

    expect(result.reconciled).toBe(false);
    expect(result.balanceMinorUnits).toBe(800);
  });

  it('is not found for a caller who does not own the account', async () => {
    await expect(
      backfillAccountBalances(client, config, 'stranger', 'R'),
    ).rejects.toBeInstanceOf(RebuildAccountNotFoundError);
  });
});
