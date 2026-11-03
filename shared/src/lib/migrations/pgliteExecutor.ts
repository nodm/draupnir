import type { PGlite } from '@electric-sql/pglite';
import { toPositional } from '../testing/pgliteDataApiClient';
import type { MigrationExecutor } from './runMigrations';

// pglite is single-connection, so "transactions" are just BEGIN/COMMIT on it;
// the transaction id is a placeholder. Test use only.
export function createPgliteExecutor(db: PGlite): MigrationExecutor {
  return {
    async begin() {
      await db.exec('BEGIN');
      return 'pglite-tx';
    },
    async execute(sql, _transactionId, parameters = {}) {
      const { text, values } = toPositional(
        sql,
        Object.entries(parameters).map(([name, value]) => ({
          name,
          value: { stringValue: value },
        })),
      );
      const result = await db.query<Record<string, unknown>>(text, values);
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
