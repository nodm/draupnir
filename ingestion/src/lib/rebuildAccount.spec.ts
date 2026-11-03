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
import { processStatementFile } from './processStatementFile';
import { rebuildAccount, RebuildAccountNotFoundError } from './rebuildAccount';

const config: DataApiConfig = {
  resourceArn: 'a',
  secretArn: 'a',
  database: 'd',
};
const fixture = (name: string) =>
  readFileSync(join(__dirname, 'parsers/__fixtures__', name), 'utf8');
const SEB = fixture('seb.csv');
const REVOLUT = fixture('revolut.csv');
const HEADER = REVOLUT.split('\n')[0] as string;

const row = (day: string, description: string, balance: string) =>
  `Card Payment,Current,2026-01-${day} 10:00:00,2026-01-${day} 10:00:00,${description},-1.00,0.00,EUR,COMPLETED,${balance}`;

describe('rebuildAccount', () => {
  let db: PGlite;
  let client: ReturnType<typeof createPgliteDataApiClient>['client'];
  let counter = 0;

  beforeAll(async () => {
    db = new PGlite();
    await applyMigrationsForTest(db);
    client = createPgliteDataApiClient(db).client;
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.exec(
      'TRUNCATE transaction_sources, transactions, raw_rows, statement_file_accounts, statement_files, account_members, accounts CASCADE',
    );
  });

  async function account(id: string, iban: string, bank: string, opening = 0) {
    await db.query(
      `INSERT INTO accounts (id, bank, iban, currency, display_name, opened_on, opening_balance_minor_units)
       VALUES ($1, $2, $3, 'EUR', $1, '2026-01-01', $4)`,
      [id, bank, iban, opening],
    );
    await db.query(
      `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, 'user-1', 'owner')`,
      [id],
    );
  }

  async function upload(contents: string, accountId: string) {
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
      `uploads/user-1/${accountId}/${counter}.csv`,
      bytes.length,
    );
  }

  const snapshot = async (accountId: string) => ({
    transactions: (
      await db.query(
        `SELECT posted_date::text, amount_minor_units::text, description, fee_minor_units::text,
                balance_after_minor_units::text, dedup_key
           FROM transactions WHERE account_id = $1 ORDER BY dedup_key`,
        [accountId],
      )
    ).rows,
    sources: (
      await db.query(
        `SELECT t.dedup_key, s.raw_row_id FROM transaction_sources s
           JOIN transactions t ON t.id = s.transaction_id
          WHERE s.account_id = $1 ORDER BY t.dedup_key, s.raw_row_id`,
        [accountId],
      )
    ).rows,
    counts: (
      await db.query(
        'SELECT file_id, new_transaction_count FROM statement_file_accounts WHERE account_id = $1 ORDER BY file_id',
        [accountId],
      )
    ).rows,
  });

  it('reproduces the original transactions, sources and counts', async () => {
    await account('R', 'LT100000000000000077', 'revolut', 1000);
    await upload(
      [HEADER, row('02', 'Alpha', '9.00'), row('03', 'Bravo', '8.00')].join(
        '\n',
      ),
      'R',
    );
    await upload(
      [HEADER, row('03', 'Bravo', '8.00'), row('04', 'Charlie', '7.00')].join(
        '\n',
      ),
      'R',
    );
    const before = await snapshot('R');

    const result = await rebuildAccount(client, config, 'R');

    expect(result).toEqual({ accountId: 'R', transactions: 3, sources: 4 });
    expect(await snapshot('R')).toEqual(before);
  });

  it('applies a fixed derivation without any re-upload', async () => {
    await account('R', 'LT100000000000000077', 'revolut', 1000);
    await upload([HEADER, row('02', 'Alpha', '9.00')].join('\n'), 'R');
    // Simulate transactions derived by older, buggy normalization.
    await db.exec(
      `UPDATE transactions SET description = 'STALE', amount_minor_units = 0`,
    );

    await rebuildAccount(client, config, 'R');

    const { rows } = await db.query<{
      description: string;
      amount_minor_units: string;
    }>('SELECT description, amount_minor_units::text FROM transactions');
    expect(rows).toEqual([
      { description: 'alpha', amount_minor_units: '-100' },
    ]);
  });

  it('rebuilds a non-selected account of a multi-account file and leaves the other untouched', async () => {
    await account('A', 'LT100000000000000001', 'seb');
    await account('B', 'LT100000000000000002', 'seb');
    await upload(SEB, 'A');
    const aBefore = await snapshot('A');
    const bBefore = await snapshot('B');
    await db.exec(
      `UPDATE transactions SET description = 'STALE' WHERE account_id = 'B'`,
    );

    const result = await rebuildAccount(client, config, 'B');

    expect(result.transactions).toBe(5);
    expect(await snapshot('B')).toEqual(bBefore);
    expect(await snapshot('A')).toEqual(aBefore);
  });

  it('replays imports in commit order (import_seq), not by processed_at', async () => {
    await account('A', 'LT100000000000000001', 'seb');
    await account('B', 'LT100000000000000002', 'seb');
    const edited = SEB.replace(
      'Withdraw money from savings deposit',
      'Edited text',
    );
    expect(edited).not.toBe(SEB);
    const first = await upload(SEB, 'A');
    await upload(edited, 'A');
    const description = async () =>
      (
        await db.query<{ description: string }>(
          `SELECT description FROM transactions WHERE account_id = 'B' AND dedup_key = 'seb:RO1000000001L01'`,
        )
      ).rows[0]?.description;
    const original = await description();
    expect(original).toContain('withdraw money');
    // Wall-clock order now contradicts commit order.
    await db.query(
      `UPDATE statement_files SET processed_at = now() + interval '1 day' WHERE id = $1`,
      [first.fileId],
    );

    await rebuildAccount(client, config, 'B');

    expect(await description()).toBe(original);
  });

  it('ignores rejected files', async () => {
    await account('R', 'LT100000000000000077', 'revolut', 1000);
    await upload('foo,bar\n', 'R');

    expect(await rebuildAccount(client, config, 'R')).toEqual({
      accountId: 'R',
      transactions: 0,
      sources: 0,
    });
  });

  it('fails for an unknown account', async () => {
    await expect(
      rebuildAccount(client, config, 'ghost'),
    ).rejects.toBeInstanceOf(RebuildAccountNotFoundError);
  });

  it('rolls back when a write fails, leaving the old transactions in place', async () => {
    await account('R', 'LT100000000000000077', 'revolut', 1000);
    await upload([HEADER, row('02', 'Alpha', '9.00')].join('\n'), 'R');
    const before = await snapshot('R');
    const failing = {
      send: async (command: {
        constructor: { name: string };
        input: { sql?: string };
      }) => {
        if (command.input.sql?.includes('INSERT INTO transactions')) {
          throw new Error('boom');
        }
        return client.send(command as never);
      },
    } as unknown as typeof client;

    await expect(rebuildAccount(failing, config, 'R')).rejects.toThrow('boom');

    expect(await snapshot('R')).toEqual(before);
  });
});
