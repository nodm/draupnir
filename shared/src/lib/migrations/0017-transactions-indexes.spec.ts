// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { applyMigrationsForTest } from './applyMigrationsForTest';

describe('0017-transactions-indexes', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await applyMigrationsForTest(db);
  });
  afterAll(async () => {
    await db.close();
  });

  it('indexes transactions for keyset pagination', async () => {
    const { rows } = await db.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'transactions'`,
    );
    const defs = rows.map((r) => r.indexdef);

    expect(defs).toContainEqual(
      expect.stringContaining('(account_id, posted_date, id)'),
    );
    expect(defs).toContainEqual(expect.stringContaining('(posted_date, id)'));
  });
});
