// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { applyMigrationsForTest } from './migrations/applyMigrationsForTest';

// docs/data-model.md describes every table and function. This keeps it honest:
// the schema the migrations really produce must match what the page says, so a
// migration that adds, drops or retypes something fails here until the page is
// updated in the same change.

// Trigger functions only their trigger calls: not granted to the app role.
const TRIGGER_ONLY = ['keep_last_owner', 'init_account_balance'];

const DOC = resolve(__dirname, '../../../docs/data-model.md');

const TYPE_NAMES: Record<string, string> = {
  'timestamp with time zone': 'timestamptz',
  'character varying': 'varchar',
};
const typeName = (dataType: string) => TYPE_NAMES[dataType] ?? dataType;

interface DocColumn {
  type: string;
  nullable: boolean;
}

function parseDoc(markdown: string) {
  const tables = new Map<string, Map<string, DocColumn>>();
  const functions = new Set<string>();
  const privileges = new Map<string, string>();
  let table: string | null = null;
  let inFunctions = false;
  let inPrivileges = false;

  for (const line of markdown.split('\n')) {
    if (line.startsWith('## ')) {
      inFunctions = line.startsWith('## Functions');
      inPrivileges = line.startsWith('## Privileges');
      table = null;
      continue;
    }
    const heading = /^### `([a-z0-9_]+)`/.exec(line);
    if (heading) {
      table = heading[1] as string;
      tables.set(table, new Map());
      continue;
    }
    const cells = line.split('|').map((c) => c.trim());
    const name = /^`([a-z0-9_]+)`$/.exec(cells[1] ?? '')?.[1];
    if (!name) continue;
    if (inPrivileges) {
      privileges.set(name, (cells[2] ?? '').replace(/\s+/g, ' '));
    } else if (inFunctions) {
      functions.add(name);
    } else if (table) {
      (tables.get(table) as Map<string, DocColumn>).set(name, {
        type: cells[2] ?? '',
        nullable: cells[3] === 'yes',
      });
    }
  }
  return { tables, functions, privileges };
}

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await applyMigrationsForTest(db);
}, 120_000);

afterAll(async () => {
  await db.close();
});

const doc = () => parseDoc(readFileSync(DOC, 'utf8'));

describe('docs/data-model.md matches the migrations', () => {
  it('describes exactly the tables that exist', async () => {
    const { rows } = await db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`,
    );
    expect([...doc().tables.keys()].sort()).toEqual(
      rows.map((r) => r.tablename),
    );
  });

  it('describes every column of every table, with its type and nullability, and no other', async () => {
    const { rows } = await db.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(`
      SELECT c.table_name, c.column_name, c.data_type, c.is_nullable
        FROM information_schema.columns c
        JOIN pg_tables t ON t.tablename = c.table_name AND t.schemaname = c.table_schema
       WHERE c.table_schema = 'public'
       ORDER BY c.table_name, c.ordinal_position`);

    const actual = new Map<string, Map<string, DocColumn>>();
    for (const r of rows) {
      if (!actual.has(r.table_name)) actual.set(r.table_name, new Map());
      actual.get(r.table_name)?.set(r.column_name, {
        type: typeName(r.data_type),
        nullable: r.is_nullable === 'YES',
      });
    }

    const documented = doc().tables;
    for (const [table, columns] of actual) {
      expect(
        Object.fromEntries(documented.get(table) ?? []),
        `columns of ${table}`,
      ).toEqual(Object.fromEntries(columns));
    }
  });

  it('lists exactly the functions of the draupnir schema', async () => {
    const { rows } = await db.query<{ proname: string }>(`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'draupnir' ORDER BY 1`);
    expect([...doc().functions].sort()).toEqual(rows.map((r) => r.proname));
  });

  it('states exactly what the application role may do to each table', async () => {
    const grants = await db.query<{ table_name: string; privs: string }>(`
      SELECT table_name, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privs
        FROM information_schema.role_table_grants
       WHERE grantee = 'draupnir_app' AND table_schema = 'public'
       GROUP BY table_name`);
    const columns = await db.query<{ table_name: string; cols: string }>(`
      SELECT table_name, string_agg(column_name, ', ' ORDER BY column_name) AS cols
        FROM information_schema.column_privileges
       WHERE grantee = 'draupnir_app' AND table_schema = 'public'
         AND privilege_type = 'UPDATE'
       GROUP BY table_name`);
    const tables = await db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`,
    );

    const tableLevel = new Map(grants.rows.map((r) => [r.table_name, r.privs]));
    const columnLevel = new Map(
      columns.rows.map((r) => [r.table_name, r.cols]),
    );
    const actual: Record<string, string> = {};
    for (const { tablename } of tables.rows) {
      const parts = (tableLevel.get(tablename) ?? '')
        .split(', ')
        .filter(Boolean);
      const columnsOnly = columnLevel.get(tablename);
      // A column-level UPDATE only counts when there is no table-level UPDATE.
      if (columnsOnly && !parts.includes('UPDATE')) {
        parts.push(`UPDATE(${columnsOnly})`);
      }
      actual[tablename] = parts.length > 0 ? parts.join(', ') : 'none';
    }

    expect(Object.fromEntries(doc().privileges)).toEqual(actual);
  });

  it('keeps every SECURITY DEFINER function pinned, closed to PUBLIC, and open to the app role except the trigger-only one', async () => {
    const { rows } = await db.query<{
      proname: string;
      prosecdef: boolean;
      app: boolean;
      public_exec: boolean;
      pinned: boolean;
    }>(`
      SELECT p.proname, p.prosecdef,
             has_function_privilege('draupnir_app', p.oid, 'EXECUTE') AS app,
             EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_exec,
             coalesce(p.proconfig, '{}') @> ARRAY['search_path=pg_catalog, pg_temp'] AS pinned
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'draupnir' ORDER BY 1`);

    const definers = rows.filter((r) => r.prosecdef);
    expect(definers.length).toBeGreaterThan(20);
    for (const f of definers) {
      expect(f.pinned, `${f.proname} pins search_path`).toBe(true);
      expect(f.public_exec, `${f.proname} closed to PUBLIC`).toBe(false);
      expect(f.app, `${f.proname} open to draupnir_app`).toBe(
        !TRIGGER_ONLY.includes(f.proname),
      );
    }
    // The only function that is not SECURITY DEFINER is the one the page says.
    expect(rows.filter((r) => !r.prosecdef).map((r) => r.proname)).toEqual([
      'current_sub',
    ]);
  });

  it('has something to check: the parser found tables, columns and functions', () => {
    const { tables, functions } = doc();
    expect(tables.size).toBeGreaterThanOrEqual(13);
    expect(tables.get('accounts')?.size).toBeGreaterThan(5);
    expect(functions.size).toBeGreaterThan(20);
  });
});
