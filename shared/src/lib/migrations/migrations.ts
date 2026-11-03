import { m0001 } from './0001-initial-schema';
import { m0002 } from './0002-statement-data-model';
import { m0003 } from './0003-import-order-and-raw-row-account';
import type { Migration } from './migration';

// Append-only, ascending by id. Never edit or remove an applied migration.
export const MIGRATIONS: readonly Migration[] = [m0001, m0002, m0003];
