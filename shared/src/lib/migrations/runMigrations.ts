import { migrationChecksum, type Migration } from './migration';

// One Data API transaction per migration (design.md decision 2). `execute`
// without a transaction id runs outside any transaction.
export interface MigrationExecutor {
  begin(): Promise<string>;
  execute(
    sql: string,
    transactionId?: string,
  ): Promise<Record<string, unknown>[]>;
  commit(transactionId: string): Promise<void>;
  rollback(transactionId: string): Promise<void>;
}

export interface MigrationClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface RunMigrationsOptions {
  executor: MigrationExecutor;
  migrations: readonly Migration[];
  // Epoch ms after which waiting for the lock is abandoned. Leave enough time
  // before the Lambda timeout for the rollback.
  lockDeadlineMs: number;
  lockPollIntervalMs?: number;
  clock?: MigrationClock;
  log?: (message: string) => void;
}

export interface RunMigrationsResult {
  applied: string[];
  skipped: string[];
}

export class MigrationChecksumMismatchError extends Error {
  constructor(readonly migrationId: string) {
    super(
      `Migration ${migrationId} was changed after it was applied; applied migrations must not be edited`,
    );
    this.name = 'MigrationChecksumMismatchError';
  }
}

export class MigrationMissingError extends Error {
  constructor(readonly migrationId: string) {
    super(
      `Migration ${migrationId} is recorded as applied but is no longer defined`,
    );
    this.name = 'MigrationMissingError';
  }
}

export class MigrationLockTimeoutError extends Error {
  constructor() {
    super('Timed out waiting for the migration lock');
    this.name = 'MigrationLockTimeoutError';
  }
}

// Arbitrary fixed key: 'draupnir' migrations.
const MIGRATION_LOCK_KEY = 727_274_001;
const DEFAULT_LOCK_POLL_INTERVAL_MS = 2000;

const realClock: MigrationClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function acquireLock(
  executor: MigrationExecutor,
  transactionId: string,
  options: Required<
    Pick<
      RunMigrationsOptions,
      'lockDeadlineMs' | 'lockPollIntervalMs' | 'clock'
    >
  >,
): Promise<void> {
  // Never the blocking pg_advisory_xact_lock: it could outlast Data API's
  // 45s statement timeout while another runner applies a long migration.
  for (;;) {
    const rows = await executor.execute(
      `SELECT pg_try_advisory_xact_lock(${MIGRATION_LOCK_KEY}) AS locked`,
      transactionId,
    );
    const locked = rows[0]?.['locked'];
    if (locked === true || locked === 't') {
      return;
    }
    if (options.clock.now() >= options.lockDeadlineMs) {
      throw new MigrationLockTimeoutError();
    }
    await options.clock.sleep(options.lockPollIntervalMs);
  }
}

async function inTransaction<T>(
  executor: MigrationExecutor,
  log: (message: string) => void,
  work: (transactionId: string) => Promise<T>,
): Promise<T> {
  const transactionId = await executor.begin();
  try {
    const result = await work(transactionId);
    await executor.commit(transactionId);
    return result;
  } catch (error) {
    try {
      await executor.rollback(transactionId);
    } catch (rollbackError) {
      log(`rollback failed: ${String(rollbackError)}`);
    }
    throw error;
  }
}

async function readRecorded(
  executor: MigrationExecutor,
  transactionId?: string,
  id?: string,
): Promise<Map<string, string>> {
  const where = id === undefined ? '' : ` WHERE id = ${quote(id)}`;
  const rows = await executor.execute(
    `SELECT id, checksum FROM schema_migrations${where}`,
    transactionId,
  );
  return new Map(
    rows.map((row) => [String(row['id']), String(row['checksum'])]),
  );
}

export async function runMigrations(
  options: RunMigrationsOptions,
): Promise<RunMigrationsResult> {
  const { executor, migrations } = options;
  const log = options.log ?? (() => undefined);
  const lockOptions = {
    lockDeadlineMs: options.lockDeadlineMs,
    lockPollIntervalMs:
      options.lockPollIntervalMs ?? DEFAULT_LOCK_POLL_INTERVAL_MS,
    clock: options.clock ?? realClock,
  };

  // Bootstrap under the lock: IF NOT EXISTS alone doesn't serialize two
  // concurrent first runs (both can hit the catalog's unique index).
  await inTransaction(executor, log, async (transactionId) => {
    await acquireLock(executor, transactionId, lockOptions);
    await executor.execute(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
  id text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`,
      transactionId,
    );
  });

  // Fast pre-check without the lock; re-checked per migration under the lock.
  const recorded = await readRecorded(executor);
  const defined = new Map(
    migrations.map((migration) => [migration.id, migration]),
  );
  for (const [id, checksum] of recorded) {
    const migration = defined.get(id);
    if (!migration) {
      throw new MigrationMissingError(id);
    }
    if (migrationChecksum(migration) !== checksum) {
      throw new MigrationChecksumMismatchError(id);
    }
  }

  const result: RunMigrationsResult = { applied: [], skipped: [] };
  const pending = [...migrations]
    .filter((migration) => !recorded.has(migration.id))
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const migration of pending) {
    const checksum = migrationChecksum(migration);
    const outcome = await inTransaction(
      executor,
      log,
      async (transactionId) => {
        await acquireLock(executor, transactionId, lockOptions);

        const current = (
          await readRecorded(executor, transactionId, migration.id)
        ).get(migration.id);
        if (current === checksum) {
          return 'skipped' as const;
        }
        if (current !== undefined) {
          throw new MigrationChecksumMismatchError(migration.id);
        }

        for (const statement of migration.statements) {
          await executor.execute(statement, transactionId);
        }
        await executor.execute(
          `INSERT INTO schema_migrations (id, checksum) VALUES (${quote(migration.id)}, ${quote(checksum)})`,
          transactionId,
        );
        return 'applied' as const;
      },
    );

    log(`${outcome} ${migration.id}`);
    result[outcome].push(migration.id);
  }

  return result;
}
