// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { applyMigrationsForTest } from './migrations/applyMigrationsForTest';

// docs/data-model.md describes every table and function. This keeps it honest:
// the schema the migrations really produce must match what the page says, so a
// migration that adds, drops or retypes something fails here until the page is
// updated in the same change.

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
  let table: string | null = null;
  let inFunctions = false;

  for (const line of markdown.split('\n')) {
    if (line.startsWith('## ')) {
      inFunctions = line.startsWith('## Functions');
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
    if (inFunctions) {
      functions.add(name);
    } else if (table) {
      (tables.get(table) as Map<string, DocColumn>).set(name, {
        type: cells[2] ?? '',
        nullable: cells[3] === 'yes',
      });
    }
  }
  return { tables, functions };
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

  it('has something to check: the parser found tables, columns and functions', () => {
    const { tables, functions } = doc();
    expect(tables.size).toBeGreaterThanOrEqual(13);
    expect(tables.get('accounts')?.size).toBeGreaterThan(5);
    expect(functions.size).toBeGreaterThan(20);
  });
});
