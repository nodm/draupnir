// @vitest-environment node
// pglite's WASM/fs loading relies on the real Node fetch/Response, which
// jsdom (this project's default test environment) does not implement.
import { PGlite } from '@electric-sql/pglite';
import { migrationChecksum, type Migration } from './migration';
import { m0001 } from './0001-initial-schema';
import { MIGRATIONS } from './migrations';
import { createPgliteExecutor } from './pgliteExecutor';
import {
  MigrationChecksumMismatchError,
  MigrationLockTimeoutError,
  runMigrations,
  type MigrationExecutor,
} from './runMigrations';

const NEVER = Number.MAX_SAFE_INTEGER;

// pglite's first start can take several seconds.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

describe('runMigrations (pglite)', () => {
  let db: PGlite;

  beforeEach(() => {
    db = new PGlite();
  });

  afterEach(async () => {
    await db.close();
  });

  function run(
    migrations: readonly Migration[],
    executor: MigrationExecutor = createPgliteExecutor(db),
    extra: { appRolePassword?: string } = {},
  ) {
    return runMigrations({
      executor,
      migrations,
      lockDeadlineMs: NEVER,
      ...extra,
    });
  }

  async function recordedIds(): Promise<string[]> {
    const result = await db.query<{ id: string }>(
      'SELECT id FROM schema_migrations ORDER BY id',
    );
    return result.rows.map((row) => row.id);
  }

  async function tableExists(name: string): Promise<boolean> {
    const result = await db.query<{ exists: boolean }>(
      'SELECT to_regclass($1) IS NOT NULL AS exists',
      [name],
    );
    return result.rows[0].exists;
  }

  const m1: Migration = {
    id: '0001-a',
    statements: ['CREATE TABLE a (id int)'],
  };
  const m2: Migration = {
    id: '0002-b',
    statements: ['CREATE TABLE b (id int)'],
  };
  const m3: Migration = {
    id: '0003-c',
    statements: ['CREATE TABLE c (id int)'],
  };

  it('applies every migration to a fresh database in id order, recording each', async () => {
    const result = await run([m1, m2]);

    expect(result.applied).toEqual(['0001-a', '0002-b']);
    const rows = await db.query<{
      id: string;
      checksum: string;
      applied_at: Date;
    }>('SELECT id, checksum, applied_at FROM schema_migrations ORDER BY id');
    expect(rows.rows.map((row) => row.id)).toEqual(['0001-a', '0002-b']);
    expect(rows.rows[0].checksum).toBe(migrationChecksum(m1));
    expect(rows.rows[0].applied_at).toBeTruthy();
  });

  it('applies only pending migrations, in ascending order', async () => {
    await run([m1]);

    const result = await run([m3, m1, m2]);

    expect(result.applied).toEqual(['0002-b', '0003-c']);
    expect(await recordedIds()).toEqual(['0001-a', '0002-b', '0003-c']);
  });

  it('changes nothing when every migration is already recorded', async () => {
    await run([m1, m2]);
    const before = await db.query(
      'SELECT * FROM schema_migrations ORDER BY id',
    );

    const result = await run([m1, m2]);

    expect(result.applied).toEqual([]);
    const after = await db.query('SELECT * FROM schema_migrations ORDER BY id');
    expect(after.rows).toEqual(before.rows);
  });

  it('rolls back the whole migration when a later statement fails, and stops', async () => {
    const failing: Migration = {
      id: '0002-b',
      statements: ['CREATE TABLE b (id int)', 'SELECT * FROM does_not_exist'],
    };

    await expect(run([m1, failing, m3])).rejects.toThrow();

    expect(await tableExists('b')).toBe(false);
    expect(await tableExists('c')).toBe(false);
    expect(await recordedIds()).toEqual(['0001-a']);
  });

  it('keeps an earlier successful migration applied when a later one fails', async () => {
    const failing: Migration = { id: '0003-c', statements: ['NOT SQL'] };

    await expect(run([m1, m2, failing])).rejects.toThrow();

    expect(await recordedIds()).toEqual(['0001-a', '0002-b']);
    expect(await tableExists('a')).toBe(true);
    expect(await tableExists('b')).toBe(true);
  });

  it('refuses an edited applied migration, naming it, and applies nothing', async () => {
    await run([m1]);
    const edited: Migration = {
      id: '0001-a',
      statements: ['CREATE TABLE a (id int, extra int)'],
    };

    const error = await run([edited, m2]).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MigrationChecksumMismatchError);
    expect((error as Error).message).toContain('0001-a');
    expect(await tableExists('b')).toBe(false);
  });

  describe('migration recorded by a concurrent run while waiting for the lock', () => {
    // Inserts the row for `concurrent` right after the unlocked pre-check read,
    // i.e. between the initial read and the per-migration transaction.
    function executorRecordingAfterPreCheck(
      concurrent: Migration,
      checksum: string,
    ): MigrationExecutor {
      const inner = createPgliteExecutor(db);
      let injected = false;
      return {
        ...inner,
        async execute(sql, transactionId) {
          const rows = await inner.execute(sql, transactionId);
          if (
            !injected &&
            transactionId === undefined &&
            sql.startsWith('SELECT id, checksum FROM schema_migrations')
          ) {
            injected = true;
            await db.query(
              'INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)',
              [concurrent.id, checksum],
            );
          }
          return rows;
        },
      };
    }

    it('skips it when the checksum matches', async () => {
      const executor = executorRecordingAfterPreCheck(
        m2,
        migrationChecksum(m2),
      );

      const result = await run([m2], executor);

      expect(result.applied).toEqual([]);
      expect(result.skipped).toEqual(['0002-b']);
      expect(await tableExists('b')).toBe(false);
    });

    it('fails naming the id when the checksum differs', async () => {
      const executor = executorRecordingAfterPreCheck(m2, 'different');

      const error = await run([m2, m3], executor).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(MigrationChecksumMismatchError);
      expect((error as Error).message).toContain('0002-b');
      expect(await tableExists('c')).toBe(false);
    });
  });

  it('creates schema_migrations inside a bootstrap transaction that holds the lock', async () => {
    const inner = createPgliteExecutor(db);
    const calls: string[] = [];
    const executor: MigrationExecutor = {
      async begin() {
        calls.push('begin');
        return inner.begin();
      },
      async execute(sql, transactionId, parameters) {
        calls.push(sql.split('\n')[0].split('(')[0].trim());
        return inner.execute(sql, transactionId, parameters);
      },
      async commit(transactionId) {
        calls.push('commit');
        return inner.commit(transactionId);
      },
      rollback: inner.rollback,
    };

    await run([], executor);

    expect(calls.slice(0, 5)).toEqual([
      'begin',
      'SELECT pg_try_advisory_xact_lock',
      'CREATE TABLE IF NOT EXISTS schema_migrations',
      'DO $$ BEGIN',
      'commit',
    ]);
  });

  it('creates the app role and sets its password without putting it in statement text', async () => {
    const inner = createPgliteExecutor(db);
    const statements: string[] = [];
    const executor: MigrationExecutor = {
      ...inner,
      async execute(sql, transactionId, parameters) {
        statements.push(sql);
        return inner.execute(sql, transactionId, parameters);
      },
    };

    await run([], executor, { appRolePassword: 's3cret-pw' });
    await run([], executor, { appRolePassword: 's3cret-pw-2' });

    const roles = await db.query<{ rolname: string; rolpassword: string }>(
      `SELECT rolname, rolpassword FROM pg_authid WHERE rolname = 'draupnir_app'`,
    );
    expect(roles.rows).toHaveLength(1);
    // Stored as a SCRAM/MD5 hash, never plaintext; changed by the second run.
    expect(roles.rows[0].rolpassword).not.toContain('s3cret');
    expect(statements.join('\n')).not.toContain('s3cret');
  });

  // 4.3 — migration 0001 against the hand-created live schema.
  it('adopts a hand-created schema: adds share_grants, keeps rows, records 0001', async () => {
    await db.exec(`
      CREATE TABLE accounts (
        id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        owner_user_id text NOT NULL,
        bank text NOT NULL CHECK (bank IN ('seb', 'revolut', 'monobank')),
        iban text NOT NULL UNIQUE,
        currency text NOT NULL,
        display_name text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (id, owner_user_id)
      );
      CREATE TABLE transactions (
        id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        owner_user_id text NOT NULL,
        account_id text NOT NULL,
        posted_date date NOT NULL,
        amount_minor_units bigint NOT NULL,
        currency text NOT NULL,
        description text NOT NULL,
        dedup_key text NOT NULL UNIQUE,
        original_currency text,
        original_amount_minor_units bigint,
        fx_fee_minor_units bigint,
        fx_fee_percent numeric,
        created_at timestamptz NOT NULL DEFAULT now(),
        CHECK ((original_currency IS NULL) = (original_amount_minor_units IS NULL)),
        CHECK ((fx_fee_minor_units IS NULL) = (fx_fee_percent IS NULL)),
        FOREIGN KEY (account_id, owner_user_id) REFERENCES accounts (id, owner_user_id)
      );
      INSERT INTO accounts (id, owner_user_id, bank, iban, currency, display_name)
        VALUES ('acc-1', 'user-1', 'seb', 'LT100000000000000001', 'EUR', 'SEB');
      INSERT INTO transactions (id, owner_user_id, account_id, posted_date, amount_minor_units, currency, description, dedup_key)
        VALUES ('tx-1', 'user-1', 'acc-1', '2026-01-02', -1250, 'EUR', 'Coffee', 'k1');
    `);
    const accountsBefore = await db.query('SELECT * FROM accounts');
    const transactionsBefore = await db.query('SELECT * FROM transactions');

    await run([m0001]);

    expect(await tableExists('share_grants')).toBe(true);
    expect((await db.query('SELECT * FROM accounts')).rows).toEqual(
      accountsBefore.rows,
    );
    expect((await db.query('SELECT * FROM transactions')).rows).toEqual(
      transactionsBefore.rows,
    );
    expect(await recordedIds()).toEqual(['0001-initial-schema']);

    // 0002 then replaces the old single-owner schema (test data is dropped).
    await run(MIGRATIONS);

    expect(await tableExists('share_grants')).toBe(false);
    expect(await tableExists('account_members')).toBe(true);
    expect((await db.query('SELECT * FROM accounts')).rows).toEqual([]);
    expect(await recordedIds()).toEqual([
      '0001-initial-schema',
      '0002-statement-data-model',
      '0003-import-order-and-raw-row-account',
      '0004-backfill-import-seq',
      '0005-row-level-security',
      '0006-rls-review-fixes',
      '0007-restrict-file-account-links',
      '0008-link-requires-upload-account-owner',
      '0009-bot',
      '0010-bot-link-helpers',
      '0011-pending-upload-offers',
      '0012-recorded-outcome-lookup',
      '0013-member-chat-lookup',
    ]);
  });
});

describe('runMigrations lock polling', () => {
  function fakeClock() {
    let time = 0;
    const sleeps: number[] = [];
    return {
      sleeps,
      clock: {
        now: () => time,
        sleep: async (ms: number) => {
          sleeps.push(ms);
          time += ms;
        },
      },
    };
  }

  function lockExecutor(lockResults: boolean[]) {
    const events: string[] = [];
    const executor: MigrationExecutor = {
      async begin() {
        events.push('begin');
        return 'tx';
      },
      async execute(sql) {
        if (sql.includes('pg_try_advisory_xact_lock')) {
          const locked = lockResults.shift() ?? true;
          events.push(`lock:${locked}`);
          return [{ locked }];
        }
        events.push(sql.split(' ').slice(0, 3).join(' '));
        return [];
      },
      async commit() {
        events.push('commit');
      },
      async rollback() {
        events.push('rollback');
      },
    };
    return { executor, events };
  }

  it('retries while the lock is taken and proceeds once it is released', async () => {
    const { clock, sleeps } = fakeClock();
    const { executor, events } = lockExecutor([false, false, true]);

    await runMigrations({
      executor,
      migrations: [],
      lockDeadlineMs: 60_000,
      lockPollIntervalMs: 2000,
      clock,
    });

    expect(events.filter((e) => e.startsWith('lock'))).toEqual([
      'lock:false',
      'lock:false',
      'lock:true',
    ]);
    expect(sleeps).toEqual([2000, 2000]);
    expect(events).toContain('commit');
  });

  it('rejects a lock that only becomes available at the deadline', async () => {
    const { clock } = fakeClock();
    const { executor, events } = lockExecutor([false, true]);

    const error = await runMigrations({
      executor,
      migrations: [],
      lockDeadlineMs: 2000,
      lockPollIntervalMs: 2000,
      clock,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MigrationLockTimeoutError);
    expect(events.at(-1)).toBe('rollback');
    expect(events).not.toContain('commit');
  });

  it('rolls back and fails with the lock-timeout error at the deadline', async () => {
    const { clock } = fakeClock();
    const { executor, events } = lockExecutor(Array(100).fill(false));

    const error = await runMigrations({
      executor,
      migrations: [],
      lockDeadlineMs: 6000,
      lockPollIntervalMs: 2000,
      clock,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MigrationLockTimeoutError);
    expect((error as Error).message).toMatch(
      /timed out waiting for the migration lock/i,
    );
    expect(events.at(-1)).toBe('rollback');
    expect(events).not.toContain('commit');
  });
});
