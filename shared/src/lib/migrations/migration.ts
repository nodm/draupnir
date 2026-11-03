import { createHash } from 'node:crypto';

export interface Migration {
  readonly id: string;
  readonly statements: readonly string[];
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

// JSON-encoding the tuple keeps id/statement boundaries unambiguous.
export function migrationChecksum(migration: Migration): string {
  return sha256(JSON.stringify([migration.id, ...migration.statements]));
}

export function migrationSetChecksum(migrations: readonly Migration[]): string {
  return sha256(
    migrations
      .map((migration) => `${migration.id}:${migrationChecksum(migration)}`)
      .join('\n'),
  );
}
