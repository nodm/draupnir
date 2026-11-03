import type { Migration } from './migration';

// FROZEN once applied. Review follow-ups to 0002:
//
// 1. Replay order. `processed_at` defaulted to now(), the *transaction start*
//    time, so an import that started first but waited on the account lock could
//    commit after a later one yet sort before it. `import_seq` is assigned at
//    INSERT, which happens after the account locks are held and before commit,
//    so for any account it follows commit order; `rebuildAccount` replays by it.
//    `processed_at` now uses clock_timestamp() for an honest wall-clock value.
//
// 2. A raw row's (file, account) must be one the file actually resolved to. The
//    constraint is deferred because the pipeline writes raw rows before the
//    per-account record; it is checked at COMMIT.
export const m0003: Migration = {
  id: '0003-import-order-and-raw-row-account',
  statements: [
    `ALTER TABLE statement_files ADD COLUMN import_seq bigint GENERATED ALWAYS AS IDENTITY`,
    `ALTER TABLE statement_files ALTER COLUMN processed_at SET DEFAULT clock_timestamp()`,
    `ALTER TABLE raw_rows
  ADD CONSTRAINT raw_rows_file_account_fk
  FOREIGN KEY (file_id, account_id) REFERENCES statement_file_accounts (file_id, account_id)
  DEFERRABLE INITIALLY DEFERRED`,
  ],
};
