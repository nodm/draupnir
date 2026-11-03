import { m0001 } from './0001-initial-schema';
import type { Migration } from './migration';

// Append-only, ascending by id. Never edit or remove an applied migration.
export const MIGRATIONS: readonly Migration[] = [m0001];
