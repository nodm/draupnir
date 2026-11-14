import type { Migration } from './migration';

// FROZEN once applied. Adds `swedbank` to the supported banks. Only the CHECK
// on accounts.bank changes (the inline constraint from 0002 has Postgres'
// default name); no row is read or rewritten.
export const m0020: Migration = {
  id: '0020-add-swedbank-bank',
  statements: [
    `ALTER TABLE accounts DROP CONSTRAINT accounts_bank_check`,
    `ALTER TABLE accounts ADD CONSTRAINT accounts_bank_check
  CHECK (bank IN ('seb', 'revolut', 'monobank', 'swedbank'))`,
  ],
};
