import {
  migrationChecksum,
  migrationSetChecksum,
  type Migration,
} from './migration';
import { MIGRATIONS } from './migrations';

describe('MIGRATIONS', () => {
  it('has unique, strictly ascending ids', () => {
    const ids = MIGRATIONS.map((migration) => migration.id);
    const sorted = [...ids].sort();

    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has a four-digit numeric prefix on every id', () => {
    for (const migration of MIGRATIONS) {
      expect(migration.id).toMatch(/^\d{4}-/);
    }
  });
});

describe('checksums', () => {
  const base: Migration = {
    id: '0001-x',
    statements: ['SELECT 1', 'SELECT 2'],
  };

  it('is stable for identical input', () => {
    expect(migrationChecksum(base)).toBe(
      migrationChecksum({ ...base, statements: [...base.statements] }),
    );
    expect(migrationSetChecksum([base])).toBe(migrationSetChecksum([base]));
  });

  it('changes when any statement changes', () => {
    const edited = { ...base, statements: ['SELECT 1', 'SELECT 3'] };

    expect(migrationChecksum(edited)).not.toBe(migrationChecksum(base));
    expect(migrationSetChecksum([edited])).not.toBe(
      migrationSetChecksum([base]),
    );
  });

  it('changes when the id changes', () => {
    expect(migrationChecksum({ ...base, id: '0002-x' })).not.toBe(
      migrationChecksum(base),
    );
  });

  it('distinguishes statement boundaries', () => {
    const joined = { id: '0001-x', statements: ['SELECT 1SELECT 2'] };
    const split = { id: '0001-x', statements: ['SELECT 1', 'SELECT 2'] };

    expect(migrationChecksum(joined)).not.toBe(migrationChecksum(split));
  });

  it('changes when a migration is added to the set', () => {
    const second = { id: '0002-y', statements: ['SELECT 1'] };

    expect(migrationSetChecksum([base, second])).not.toBe(
      migrationSetChecksum([base]),
    );
  });
});
