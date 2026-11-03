import type { PGlite } from '@electric-sql/pglite';
import type { MigrationExecutor } from './runMigrations';

// pglite is single-connection, so "transactions" are just BEGIN/COMMIT on it;
// the transaction id is a placeholder. Test use only.
export function createPgliteExecutor(db: PGlite): MigrationExecutor {
  return {
    async begin() {
      await db.exec('BEGIN');
      return 'pglite-tx';
    },
    async execute(sql) {
      const result = await db.query<Record<string, unknown>>(sql);
      return result.rows;
    },
    async commit() {
      await db.exec('COMMIT');
    },
    async rollback() {
      await db.exec('ROLLBACK');
    },
  };
}
