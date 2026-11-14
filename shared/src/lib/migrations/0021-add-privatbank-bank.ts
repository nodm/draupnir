import type { Migration } from './migration';

// FROZEN once applied. Adds `privatbank` to the supported banks. Only the CHECK
// on accounts.bank changes; no row is read or rewritten.
export const m0021: Migration = {
  id: '0021-add-privatbank-bank',
  statements: [
    `ALTER TABLE accounts DROP CONSTRAINT accounts_bank_check`,
    `ALTER TABLE accounts ADD CONSTRAINT accounts_bank_check
  CHECK (bank IN ('seb', 'revolut', 'monobank', 'swedbank', 'privatbank'))`,
  ],
};
