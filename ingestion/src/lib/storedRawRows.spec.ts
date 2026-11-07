// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import {
  applyMigrationsForTest,
  createPgliteDataApiClient,
  withCaller,
  type DataApiConfig,
} from 'shared';
import { loadStoredRawRows } from './storedRawRows';

const config: DataApiConfig = {
  resourceArn: 'a',
  secretArn: 'a',
  database: 'd',
};

describe('loadStoredRawRows', () => {
  let db: PGlite;
  let client: ReturnType<typeof createPgliteDataApiClient>['client'];

  beforeAll(async () => {
    db = new PGlite();
    await applyMigrationsForTest(db);
    client = createPgliteDataApiClient(db, { role: 'draupnir_app' }).client;
    await db.exec(`
      INSERT INTO accounts (id, bank, iban, currency, display_name, opened_on, opening_balance_minor_units)
        VALUES ('R', 'revolut', 'IBAN', 'EUR', 'R', '2026-01-01', 0);
      INSERT INTO account_members (account_id, user_id, role) VALUES ('R', 'u', 'owner');
      INSERT INTO statement_files (id, upload_account_id, uploaded_by, bank, sha256, s3_key, status) VALUES
        ('f1', 'R', 'u', 'revolut', 'h1', 'k1', 'approved'),
        ('f2', 'R', 'u', 'revolut', 'h2', 'k2', 'approved');
      INSERT INTO statement_file_accounts (file_id, account_id) VALUES ('f1', 'R'), ('f2', 'R');
      INSERT INTO raw_rows (id, file_id, account_id, row_number, bank, format_version, payload)
        SELECT f.id || '-' || n, f.id, 'R', n, 'revolut', 'v1', '{"x":"1"}'
          FROM (VALUES ('f2'), ('f1')) f(id), generate_series(1, 5) n;
    `);
  }, 60_000);
  afterAll(async () => {
    await db.close();
  });

  const load = (pageSize?: number) =>
    withCaller(client, config, 'u', async (tx) => {
      const { filesInOrder } = await loadStoredRawRows(
        client,
        config,
        tx,
        'R',
        'IBAN',
        pageSize,
      );
      return filesInOrder.map((f) => f.rows.map((r) => r.rawRowId));
    });

  it('returns every row once, in import order, whatever the page size', async () => {
    const whole = await load();

    for (const size of [1, 2, 3, 5, 7]) {
      expect(await load(size)).toEqual(whole);
    }
    // f1 has the lower import_seq although its rows were inserted second.
    expect(whole.map((rows) => rows.length)).toEqual([5, 5]);
    expect(whole[0]?.[0]).toBe('f1-1');
  });
});
