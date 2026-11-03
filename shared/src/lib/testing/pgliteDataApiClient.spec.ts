// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import {
  BatchExecuteStatementCommand,
  ExecuteStatementCommand,
} from '@aws-sdk/client-rds-data';
import { applyMigrationsForTest } from '../migrations/applyMigrationsForTest';
import { createPgliteDataApiClient } from './pgliteDataApiClient';

const base = { resourceArn: 'a', secretArn: 'b', database: 'c' };

describe('createPgliteDataApiClient with a role', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await applyMigrationsForTest(db);
    await db.exec(
      `INSERT INTO accounts (id, bank, iban, currency, display_name, opened_on, opening_balance_minor_units)
       VALUES ('a1', 'seb', 'IBANX', 'EUR', 'n', '2024-01-01', 0)`,
    );
  }, 60_000);
  afterAll(async () => {
    await db.close();
  });

  it('runs an unscoped single statement as the role with no identity', async () => {
    const { client } = createPgliteDataApiClient(db, { role: 'draupnir_app' });
    const r = await client.send(
      new ExecuteStatementCommand({
        ...base,
        sql: 'SELECT count(*)::int AS n FROM accounts',
        formatRecordsAs: 'JSON',
      }),
    );
    expect(JSON.parse(r.formattedRecords as string)).toEqual([{ n: 0 }]);
  });

  it('runs an unscoped batch as the role too, so RLS and grants apply', async () => {
    const { client } = createPgliteDataApiClient(db, { role: 'draupnir_app' });
    await expect(
      client.send(
        new BatchExecuteStatementCommand({
          ...base,
          sql: `UPDATE accounts SET display_name = :name`,
          parameterSets: [[{ name: 'name', value: { stringValue: 'x' } }]],
        }),
      ),
    ).resolves.toBeDefined();
    // Filtered by RLS (no identity), so nothing changed; as the owner it would have.
    const row = await db.query<{ display_name: string }>(
      `SELECT display_name FROM accounts WHERE id = 'a1'`,
    );
    expect(row.rows[0].display_name).toBe('n');
    // And the role is reset afterwards.
    const who = await db.query<{ u: string }>('SELECT current_user AS u');
    expect(who.rows[0].u).not.toBe('draupnir_app');
  });
});
