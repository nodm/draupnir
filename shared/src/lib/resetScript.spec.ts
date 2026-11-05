// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { MIGRATIONS } from './migrations/migrations';
import { createPgliteExecutor } from './migrations/pgliteExecutor';
import { runMigrations } from './migrations/runMigrations';

// infra/scripts/reset-data.sh empties the database. Its table lists must name
// every table, so a table added later cannot be missed, and its TRUNCATE must
// be one the database actually accepts (it has no CASCADE, so every table that
// references another must be listed).

const SCRIPT = resolve(__dirname, '../../../infra/scripts/reset-data.sh');
const source = readFileSync(SCRIPT, 'utf8');

const list = (name: string): string[] => {
  const match = new RegExp(`^${name}="([^"]*)"$`, 'm').exec(source);
  if (!match) throw new Error(`${name} not found in reset-data.sh`);
  return (match[1] as string).split(/\s+/).filter(Boolean);
};

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  // Built by the real runner, as in production: it also creates
  // `schema_migrations`, which the spec-only shortcut skips.
  await runMigrations({
    executor: createPgliteExecutor(db),
    migrations: MIGRATIONS,
    lockDeadlineMs: Number.MAX_SAFE_INTEGER,
  });
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe('infra/scripts/reset-data.sh', () => {
  it('names every table exactly once, as either emptied or kept', async () => {
    const { rows } = await db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`,
    );
    const reset = list('RESET_TABLES');
    const kept = list('KEPT_TABLES');

    expect(new Set(reset).size).toBe(reset.length);
    expect(reset.filter((t) => kept.includes(t))).toEqual([]);
    expect([...reset, ...kept].sort()).toEqual(rows.map((r) => r.tablename));
  });

  it('keeps the tables retention and the migration runner still need', () => {
    expect(list('KEPT_TABLES')).toEqual(
      expect.arrayContaining(['bot_messages', 'schema_migrations']),
    );
  });

  it('uses a TRUNCATE the database accepts, with no CASCADE', async () => {
    const code = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    expect(code).not.toMatch(/CASCADE/i);
    await db.exec(`TRUNCATE ${list('RESET_TABLES').join(', ')}`);
  });

  it('really leaves the kept tables alone', async () => {
    await db.exec(`
      INSERT INTO messenger_links (telegram_user_id, user_id, email) VALUES (1, 'u', 'u@example.com');
      INSERT INTO bot_messages (chat_id, message_id, user_id) VALUES (1, 1, 'u')`);

    await db.exec(`TRUNCATE ${list('RESET_TABLES').join(', ')}`);

    const count = async (table: string) =>
      Number(
        (await db.query<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))
          .rows[0]?.n,
      );
    expect(await count('messenger_links')).toBe(0);
    expect(await count('bot_messages')).toBe(1);
    // the runner's record of what is applied, without which the next deploy
    // would try to apply every migration again
    expect(await count('schema_migrations')).toBe(MIGRATIONS.length);
  });

  it('would be refused if a referenced table were left out (so the check above means something)', async () => {
    // `accounts` is referenced by other tables, so emptying it alone fails.
    await expect(db.exec('TRUNCATE accounts')).rejects.toThrow(
      /foreign key|cannot truncate/i,
    );
  });
});
