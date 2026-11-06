import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// `shared/dataTools` (tsconfig.base.json) lets a Lambda bundle the data tools
// without the rest of `shared`. Bundlers follow imports, so this walks the
// entry point's relative imports and fails if anything heavy or test-only
// becomes reachable (e.g. via a barrel import).
const ENTRY = resolve(__dirname, 'index.ts');
const FORBIDDEN_PACKAGES = [
  '@electric-sql/pglite',
  'pgsql-ast-parser',
  '@aws-sdk/client-sqs',
];
const FORBIDDEN_PATHS = [/\/lib\/testing\//, /\/lib\/migrations\//];

function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)].map(
    (m) => m[1] as string,
  );
}

function reachable(entry: string) {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    for (const spec of importsOf(file)) {
      if (spec.startsWith('.')) {
        visit(resolve(dirname(file), `${spec}.ts`));
      } else {
        packages.add(spec);
      }
    }
  };
  visit(entry);
  return { files: [...files], packages: [...packages] };
}

describe('shared/dataTools entry point', () => {
  const { files, packages } = reachable(ENTRY);

  it('does not reach pglite, SQS, migrations, or test helpers', () => {
    expect(packages.filter((p) => FORBIDDEN_PACKAGES.includes(p))).toEqual([]);
    expect(
      files.filter((f) => FORBIDDEN_PATHS.some((re) => re.test(f))),
    ).toEqual([]);
  });

  it('only needs zod and the RDS Data API client at runtime', () => {
    expect(packages.filter((p) => !p.startsWith('node:')).sort()).toEqual([
      '@aws-sdk/client-rds-data',
      'zod',
    ]);
  });
});
