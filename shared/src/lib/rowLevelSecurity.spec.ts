// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { applyMigrationsForTest } from './migrations/applyMigrationsForTest';

// Everything here runs as the non-owner `draupnir_app` role, inside one
// transaction per "request", exactly as withCaller does it.

let db: PGlite;

async function asApp<T>(sub: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec('SET ROLE draupnir_app');
  await db.exec('BEGIN');
  try {
    if (sub !== null) {
      await db.query(`SELECT set_config('app.sub', $1, true)`, [sub]);
    }
    const result = await fn();
    await db.exec('COMMIT');
    return result;
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function ids(sub: string | null, table: string): Promise<string[]> {
  return asApp(sub, async () => {
    const result = await db.query<{ id: string }>(
      `SELECT id FROM ${table} ORDER BY id`,
    );
    return result.rows.map((r) => r.id);
  });
}

// An UPDATE/DELETE hidden by RLS affects zero rows rather than raising.
async function affected(sub: string | null, sql: string): Promise<number> {
  return asApp(sub, async () => (await db.query(sql)).affectedRows ?? 0);
}

beforeAll(async () => {
  db = new PGlite();
  await applyMigrationsForTest(db);
  // Seed as the owner (bypasses RLS).
  //   acc1: alice owner, bob viewer   acc2: alice owner   acc3: bob owner
  await db.exec(`
    INSERT INTO accounts (id, bank, iban, currency, display_name, opened_on, opening_balance_minor_units) VALUES
      ('acc1', 'seb', 'IBAN1', 'EUR', 'one', '2024-01-01', 0),
      ('acc2', 'seb', 'IBAN2', 'EUR', 'two', '2024-01-01', 0),
      ('acc3', 'seb', 'IBAN3', 'EUR', 'three', '2024-01-01', 0);
    INSERT INTO account_members (account_id, user_id, role) VALUES
      ('acc1', 'alice', 'owner'), ('acc1', 'bob', 'viewer'),
      ('acc2', 'alice', 'owner'), ('acc3', 'bob', 'owner');
    INSERT INTO statement_files (id, upload_account_id, uploaded_by, bank, sha256, s3_key, status, rejection_reasons) VALUES
      ('f1', 'acc1', 'alice', 'seb', 'h1', 'k1', 'approved', NULL),
      ('f2', 'acc1', 'alice', 'seb', 'h2', 'k2', 'rejected', '[{"code":"x"}]'),
      ('f3', 'acc3', 'bob', 'seb', 'h3', 'k3', 'approved', NULL),
      -- uploaded for acc2 by alice but resolved to acc3 too (bob's account)
      ('f4', 'acc2', 'alice', 'seb', 'h4', 'k4', 'approved', NULL),
      -- uploaded by dave, who is not a member of acc2 (e.g. removed since)
      ('f5', 'acc2', 'dave', 'seb', 'h5', 'k5', 'approved', NULL);
    INSERT INTO statement_file_accounts (file_id, account_id) VALUES
      ('f1', 'acc1'), ('f3', 'acc3'), ('f4', 'acc2'), ('f4', 'acc3');
    INSERT INTO raw_rows (id, file_id, account_id, row_number, bank, format_version, payload) VALUES
      ('r1', 'f1', 'acc1', 1, 'seb', 'v1', '{}'),
      ('r3', 'f3', 'acc3', 1, 'seb', 'v1', '{}');
    INSERT INTO transactions (id, account_id, posted_date, amount_minor_units, currency, description, dedup_key) VALUES
      ('t1', 'acc1', '2024-01-02', 100, 'EUR', 'd', 'k1'),
      ('t2', 'acc2', '2024-01-02', 100, 'EUR', 'd', 'k2'),
      ('t3', 'acc3', '2024-01-02', 100, 'EUR', 'd', 'k3');
    INSERT INTO transaction_sources (transaction_id, raw_row_id, account_id) VALUES ('t1', 'r1', 'acc1');
  `);
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe('role', () => {
  it('owns nothing and cannot bypass RLS', async () => {
    const role = await db.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'draupnir_app'`,
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const owned = await db.query(
      `SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
        WHERE r.rolname = 'draupnir_app'`,
    );
    expect(owned.rows).toEqual([]);
  });

  it('has no access to schema_migrations', async () => {
    // Created by the runner in production, not by applyMigrationsForTest.
    await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id text)`);
    await expect(
      asApp('alice', () => db.query('SELECT * FROM schema_migrations')),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('reads', () => {
  it('filterless query returns only the caller’s accounts’ rows', async () => {
    expect(await ids('alice', 'transactions')).toEqual(['t1', 't2']);
    expect(await ids('bob', 'transactions')).toEqual(['t1', 't3']);
    expect(await ids('carol', 'transactions')).toEqual([]);
  });

  it('a viewer sees the shared account but not the owner’s other accounts', async () => {
    expect(await ids('bob', 'accounts')).toEqual(['acc1', 'acc3']);
    expect(await ids('bob', 'raw_rows')).toEqual(['r1', 'r3']);
  });

  it('covers every account-scoped table', async () => {
    const counts = await asApp('carol', async () => {
      const out: number[] = [];
      for (const table of [
        'accounts',
        'account_members',
        'statement_files',
        'statement_file_accounts',
        'raw_rows',
        'transactions',
        'transaction_sources',
      ]) {
        const r = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${table}`,
        );
        out.push(r.rows[0].n);
      }
      return out;
    });
    expect(counts).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it('rejected files are visible to the uploader only; approved to upload-account members', async () => {
    expect(await ids('alice', 'statement_files')).toEqual([
      'f1',
      'f2',
      'f4',
      'f5',
    ]);
    // bob: viewer of acc1 sees approved f1, not alice's rejected f2; own f3.
    expect(await ids('bob', 'statement_files')).toContain('f1');
    expect(await ids('bob', 'statement_files')).not.toContain('f2');
    expect(await ids('carol', 'statement_files')).toEqual([]);
  });

  it('an approved file is visible through any account it resolved to', async () => {
    // f4 was uploaded for acc2, but bob owns acc3, which f4 resolved to.
    expect(await ids('bob', 'statement_files')).toEqual(['f1', 'f3', 'f4']);
  });

  it('the uploader loses an approved file once removed from its upload account', async () => {
    // dave uploaded f5 for acc2 but is not a member of it.
    expect(await ids('dave', 'statement_files')).toEqual([]);
  });

  it('a temporary table named account_members cannot fake membership', async () => {
    const seen = await asApp('carol', async () => {
      await db.exec(
        `CREATE TEMP TABLE account_members (account_id text, user_id text, role text) ON COMMIT DROP`,
      );
      await db.exec(
        `INSERT INTO account_members VALUES ('acc1', 'carol', 'owner')`,
      );
      const r = await db.query<{ id: string }>('SELECT id FROM transactions');
      return r.rows;
    });
    expect(seen).toEqual([]);
  });
});

describe('statement_file_accounts links', () => {
  it('an owner cannot link someone else’s file to their own account', async () => {
    // f3 belongs to bob's acc3; alice owns acc2 but not acc3 and didn't upload f3.
    await expect(
      asApp('alice', () =>
        db.exec(
          `INSERT INTO statement_file_accounts (file_id, account_id) VALUES ('f3', 'acc2')`,
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    expect(await ids('alice', 'statement_files')).not.toContain('f3');
  });

  it('the uploader or an owner of the upload account can link a resolved account', async () => {
    await asApp('alice', () =>
      db.exec(
        `INSERT INTO statement_file_accounts (file_id, account_id) VALUES ('f2', 'acc2')`,
      ),
    );
    await db.exec(
      `DELETE FROM statement_file_accounts WHERE file_id = 'f2' AND account_id = 'acc2'`,
    );
  });

  it('only new_transaction_count can be updated; links cannot be rewritten', async () => {
    expect(
      await affected(
        'alice',
        `UPDATE statement_file_accounts SET new_transaction_count = 3 WHERE file_id = 'f1'`,
      ),
    ).toBe(1);
    await expect(
      asApp('alice', () =>
        db.exec(
          `UPDATE statement_file_accounts SET file_id = 'f3' WHERE file_id = 'f1'`,
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asApp('alice', () =>
        db.exec(
          `UPDATE statement_file_accounts SET account_id = 'acc2' WHERE file_id = 'f1'`,
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('last owner', () => {
  async function newAccount(owner: string, iban: string): Promise<string> {
    return asApp(owner, async () => {
      const r = await db.query<{ id: string }>(
        `SELECT draupnir.create_account('seb', $1, 'EUR', 'n', '2024-01-01', 0) AS id`,
        [iban],
      );
      return r.rows[0].id;
    });
  }

  it('the only owner cannot be deleted or demoted', async () => {
    const id = await newAccount('erin', 'IBANLO1');
    await expect(
      asApp('erin', () =>
        db.query(`DELETE FROM account_members WHERE account_id = $1`, [id]),
      ),
    ).rejects.toThrow(/at least one owner/);
    await expect(
      asApp('erin', () =>
        db.query(
          `UPDATE account_members SET role = 'viewer' WHERE account_id = $1`,
          [id],
        ),
      ),
    ).rejects.toThrow(/at least one owner/);
    await expect(
      asApp('erin', () =>
        db.query(
          `UPDATE account_members SET user_id = 'other' WHERE account_id = $1`,
          [id],
        ),
      ),
    ).rejects.toThrow(/at least one owner/);
  });

  it('an owner can step down while another owner remains, but the last cannot', async () => {
    const id = await newAccount('erin', 'IBANLO2');
    await asApp('erin', () =>
      db.query(
        `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, 'frank', 'owner')`,
        [id],
      ),
    );
    await asApp('erin', () =>
      db.query(
        `UPDATE account_members SET role = 'viewer' WHERE account_id = $1 AND user_id = 'erin'`,
        [id],
      ),
    );
    await expect(
      asApp('frank', () =>
        db.query(
          `DELETE FROM account_members WHERE account_id = $1 AND user_id = 'frank'`,
          [id],
        ),
      ),
    ).rejects.toThrow(/at least one owner/);
  });
});

describe('unidentified caller', () => {
  it('sees nothing', async () => {
    expect(await ids(null, 'accounts')).toEqual([]);
    expect(await ids(null, 'transactions')).toEqual([]);
  });

  it('cannot write', async () => {
    await expect(
      asApp(null, () =>
        db.exec(
          `INSERT INTO transactions (account_id, posted_date, amount_minor_units, currency, description, dedup_key)
           VALUES ('acc1', '2024-02-01', 1, 'EUR', 'd', 'x')`,
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    expect(
      await affected(null, `UPDATE transactions SET description = 'z'`),
    ).toBe(0);
  });

  it('create_account refuses', async () => {
    await expect(
      asApp(null, () =>
        db.query(
          `SELECT draupnir.create_account('seb', 'IBANX', 'EUR', 'n', '2024-01-01', 0)`,
        ),
      ),
    ).rejects.toThrow(/no caller identified/);
  });

  it('identity does not carry into the next transaction on the same session', async () => {
    expect(await ids('alice', 'accounts')).toEqual(['acc1', 'acc2']);
    expect(await ids(null, 'accounts')).toEqual([]);
  });
});

describe('writes', () => {
  const insertTransaction = (account: string, key: string) =>
    `INSERT INTO transactions (account_id, posted_date, amount_minor_units, currency, description, dedup_key)
     VALUES ('${account}', '2024-02-01', 1, 'EUR', 'd', '${key}')`;

  it('an owner can write to their account', async () => {
    await asApp('alice', () => db.exec(insertTransaction('acc1', 'owner-ok')));
    expect(
      await affected(
        'alice',
        `DELETE FROM transactions WHERE dedup_key = 'owner-ok'`,
      ),
    ).toBe(1);
  });

  it('a viewer cannot insert statement_files or transactions', async () => {
    await expect(
      asApp('bob', () => db.exec(insertTransaction('acc1', 'v1'))),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asApp('bob', () =>
        db.exec(
          `INSERT INTO statement_files (upload_account_id, uploaded_by, bank, sha256, s3_key, status)
           VALUES ('acc1', 'bob', 'seb', 'hv', 'kv', 'approved')`,
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('a viewer cannot write transaction_sources', async () => {
    await expect(
      asApp('bob', () =>
        db.exec(
          `INSERT INTO transaction_sources (transaction_id, raw_row_id, account_id) VALUES ('t1', 'r1', 'acc1')`,
        ),
      ),
    ).rejects.toThrow(/row-level security|duplicate key/);
    expect(
      await affected(
        'bob',
        `DELETE FROM transaction_sources WHERE account_id = 'acc1'`,
      ),
    ).toBe(0);
    expect(
      await affected(
        'bob',
        `UPDATE transactions SET description = 'z' WHERE id = 't1'`,
      ),
    ).toBe(0);
  });

  it('a file cannot be uploaded as someone else', async () => {
    await expect(
      asApp('alice', () =>
        db.exec(
          `INSERT INTO statement_files (upload_account_id, uploaded_by, bank, sha256, s3_key, status)
           VALUES ('acc1', 'bob', 'seb', 'hx', 'kx', 'approved')`,
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('an update cannot move a row into an account the caller does not own', async () => {
    await expect(
      asApp('alice', () =>
        db.exec(`UPDATE transactions SET account_id = 'acc3' WHERE id = 't1'`),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('create_account makes the caller its only owner', async () => {
    const accountId = await asApp('carol', async () => {
      const r = await db.query<{ id: string }>(
        `SELECT draupnir.create_account('revolut', 'IBANC', 'EUR', 'carols', '2024-01-01', 500) AS id`,
      );
      return r.rows[0].id;
    });
    const members = await db.query(
      `SELECT user_id, role FROM account_members WHERE account_id = $1`,
      [accountId],
    );
    expect(members.rows).toEqual([{ user_id: 'carol', role: 'owner' }]);
    expect(await ids('carol', 'accounts')).toEqual([accountId]);
  });

  it('the app role cannot insert into accounts directly', async () => {
    await expect(
      asApp('carol', () =>
        db.exec(
          `INSERT INTO accounts (bank, iban, currency, display_name, opened_on, opening_balance_minor_units)
           VALUES ('seb', 'IBANZ', 'EUR', 'n', '2024-01-01', 0)`,
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('a caller cannot add themselves to someone else’s account', async () => {
    await expect(
      asApp('carol', () =>
        db.exec(
          `INSERT INTO account_members (account_id, user_id, role) VALUES ('acc2', 'carol', 'owner')`,
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    // A viewer can't promote themselves either.
    expect(
      await affected(
        'bob',
        `UPDATE account_members SET role = 'owner' WHERE user_id = 'bob' AND account_id = 'acc1'`,
      ),
    ).toBe(0);
  });
});

// Guards: a later change that adds a table or a SECURITY DEFINER function
// without following the rules fails here.
async function tablesWithoutRls(): Promise<string[]> {
  const r = await db.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname <> 'schema_migrations'
        AND (NOT c.relrowsecurity
             OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid))
      ORDER BY c.relname`,
  );
  return r.rows.map((row) => row.relname);
}

async function unsafeDefinerFunctions(): Promise<string[]> {
  const r = await db.query<{ proname: string }>(
    `SELECT p.proname FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('public', 'draupnir') AND p.prosecdef
        AND (p.proconfig IS NULL
             OR NOT ('search_path=pg_catalog, pg_temp' = ANY (p.proconfig))
             OR p.proacl IS NULL
             OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0))
      ORDER BY p.proname`,
  );
  return r.rows.map((row) => row.proname);
}

describe('guards', () => {
  it('every public table except schema_migrations has RLS and a policy', async () => {
    expect(await tablesWithoutRls()).toEqual([]);
  });

  it('every SECURITY DEFINER function pins search_path and is not executable by PUBLIC', async () => {
    expect(await unsafeDefinerFunctions()).toEqual([]);
  });

  it('the guards fail for a table without policies and an unsafe function', async () => {
    await db.exec(`CREATE TABLE scratch_no_rls (id int)`);
    await db.exec(
      `CREATE TABLE scratch_partitioned (id int) PARTITION BY RANGE (id)`,
    );
    await db.exec(
      `CREATE FUNCTION draupnir.scratch_unsafe() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$`,
    );
    try {
      expect(await tablesWithoutRls()).toEqual([
        'scratch_no_rls',
        'scratch_partitioned',
      ]);
      expect(await unsafeDefinerFunctions()).toEqual(['scratch_unsafe']);
    } finally {
      await db.exec(`DROP TABLE scratch_no_rls`);
      await db.exec(`DROP TABLE scratch_partitioned`);
      await db.exec(`DROP FUNCTION draupnir.scratch_unsafe()`);
    }
  });
});
