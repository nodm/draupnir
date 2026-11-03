import type { PGlite } from '@electric-sql/pglite';
import { MIGRATIONS } from './migrations';

// Spec-only shortcut: applies every statement directly, bypassing the runner,
// so schema specs don't depend on runner behavior.
export async function applyMigrationsForTest(db: PGlite): Promise<void> {
  // The runner creates this role in production (its password isn't static SQL).
  await db.exec(
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'draupnir_app') THEN
         CREATE ROLE draupnir_app LOGIN;
       END IF;
     END $$`,
  );
  for (const migration of MIGRATIONS) {
    for (const statement of migration.statements) {
      await db.exec(statement);
    }
  }
}
