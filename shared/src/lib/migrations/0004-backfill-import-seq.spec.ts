// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { m0001 } from './0001-initial-schema';
import { m0002 } from './0002-statement-data-model';
import { m0003 } from './0003-import-order-and-raw-row-account';
import { m0004 } from './0004-backfill-import-seq';
import type { Migration } from './migration';

async function apply(db: PGlite, ...migrations: Migration[]) {
  for (const migration of migrations) {
    for (const statement of migration.statements) await db.exec(statement);
  }
}

describe('0004 backfill of import_seq', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = new PGlite();
    await apply(db, m0001, m0002, m0003);
    await db.exec(`INSERT INTO accounts (id, bank, iban, currency, display_name, opened_on, opening_balance_minor_units)
      VALUES ('A', 'seb', 'LT1', 'EUR', 'A', '2024-01-01', 0)`);
  });
  afterEach(async () => {
    await db.close();
  });

  const insertFile = (id: string, processedAt: string) =>
    db.query(
      `INSERT INTO statement_files (id, upload_account_id, uploaded_by, bank, sha256, s3_key, status, processed_at)
       VALUES ($1, 'A', 'u', 'seb', $1, $1, 'approved', $2)`,
      [id, processedAt],
    );

  it('renumbers pre-existing rows by processed_at then id, deterministically', async () => {
    // Insert order (which 0003's identity followed) disagrees with processed_at.
    await insertFile('c', '2026-01-03T00:00:00Z');
    await insertFile('a', '2026-01-01T00:00:00Z');
    await insertFile('b', '2026-01-01T00:00:00Z');

    await apply(db, m0004);

    const { rows } = await db.query<{ id: string; import_seq: string }>(
      'SELECT id, import_seq::text FROM statement_files ORDER BY import_seq',
    );
    expect(rows).toEqual([
      { id: 'a', import_seq: '1' },
      { id: 'b', import_seq: '2' },
      { id: 'c', import_seq: '3' },
    ]);
  });

  it('continues numbering after the backfill and stays generated-always', async () => {
    await insertFile('x', '2026-01-02T00:00:00Z');
    await insertFile('y', '2026-01-01T00:00:00Z');
    await apply(db, m0004);

    await insertFile('z', '2026-01-05T00:00:00Z');

    const { rows } = await db.query<{ id: string; import_seq: string }>(
      'SELECT id, import_seq::text FROM statement_files ORDER BY import_seq',
    );
    expect(rows.map((r) => [r.id, r.import_seq])).toEqual([
      ['y', '1'],
      ['x', '2'],
      ['z', '3'],
    ]);
    await expect(
      db.exec(`INSERT INTO statement_files (id, upload_account_id, uploaded_by, bank, sha256, s3_key, status, import_seq)
        VALUES ('w', 'A', 'u', 'seb', 'w', 'w', 'approved', 99)`),
    ).rejects.toThrow();
  });

  it('is a no-op on an empty table; numbering starts at 1', async () => {
    await apply(db, m0004);

    await insertFile('first', '2026-01-01T00:00:00Z');

    const { rows } = await db.query<{ import_seq: string }>(
      'SELECT import_seq::text FROM statement_files',
    );
    expect(rows).toEqual([{ import_seq: '1' }]);
  });
});
