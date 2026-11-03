import type { PGlite } from '@electric-sql/pglite';
import { MIGRATIONS } from './migrations';

// Spec-only shortcut: applies every statement directly, bypassing the runner,
// so schema specs don't depend on runner behavior.
export async function applyMigrationsForTest(db: PGlite): Promise<void> {
  for (const migration of MIGRATIONS) {
    for (const statement of migration.statements) {
      await db.exec(statement);
    }
  }
}
