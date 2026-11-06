import type { Migration } from './migration';

// FROZEN once applied. Keyset pagination for the data tools orders
// transactions by (posted_date, id) newest first, either across every visible
// account or within one. Indexes only; no new tables or policies.
export const m0017: Migration = {
  id: '0017-transactions-indexes',
  statements: [
    `CREATE INDEX transactions_account_posted_date_id_idx ON transactions (account_id, posted_date, id)`,
    `CREATE INDEX transactions_posted_date_id_idx ON transactions (posted_date, id)`,
  ],
};
