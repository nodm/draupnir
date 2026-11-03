import type { Migration } from './migration';

// FROZEN once applied. Replaces the single-owner schema with account
// membership and the three-layer statement model (docs/adr/0008). The old
// tables held test data only, so they are dropped rather than converted.
//
// Every account-scoped table carries its own account_id, so row-level policies
// (add-row-level-security) are a uniform membership check. The composite FKs on
// transaction_sources make the database guarantee that a source link joins a
// transaction and a raw row of the same account.
export const m0002: Migration = {
  id: '0002-statement-data-model',
  statements: [
    `DROP TABLE IF EXISTS share_grants`,
    `DROP TABLE IF EXISTS transactions`,
    `DROP TABLE IF EXISTS accounts`,
    `CREATE TABLE accounts (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  bank text NOT NULL CHECK (bank IN ('seb', 'revolut', 'monobank')),
  iban text NOT NULL UNIQUE,
  currency text NOT NULL,
  display_name text NOT NULL,
  opened_on date NOT NULL,
  opening_balance_minor_units bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
)`,
    `CREATE TABLE account_members (
  account_id text NOT NULL REFERENCES accounts (id),
  user_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id)
)`,
    `CREATE INDEX account_members_user_id_idx ON account_members (user_id)`,
    `CREATE TABLE statement_files (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  upload_account_id text NOT NULL REFERENCES accounts (id),
  uploaded_by text NOT NULL,
  bank text NOT NULL,
  format_version text,
  sha256 text NOT NULL,
  s3_key text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('approved', 'rejected')),
  rejection_reasons jsonb,
  processed_at timestamptz NOT NULL DEFAULT now()
)`,
    `CREATE UNIQUE INDEX statement_files_approved_sha256_idx
  ON statement_files (upload_account_id, sha256) WHERE status = 'approved'`,
    `CREATE TABLE statement_file_accounts (
  file_id text NOT NULL REFERENCES statement_files (id),
  account_id text NOT NULL REFERENCES accounts (id),
  declared_from date,
  declared_to date,
  activity_from date,
  activity_to date,
  opening_balance_minor_units bigint,
  closing_balance_minor_units bigint,
  new_transaction_count integer NOT NULL DEFAULT 0,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (file_id, account_id)
)`,
    `CREATE INDEX statement_file_accounts_account_id_idx ON statement_file_accounts (account_id)`,
    `CREATE TABLE raw_rows (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  file_id text NOT NULL REFERENCES statement_files (id),
  account_id text NOT NULL REFERENCES accounts (id),
  row_number integer NOT NULL,
  bank text NOT NULL,
  format_version text NOT NULL,
  bank_transaction_id text,
  payload jsonb NOT NULL,
  UNIQUE (file_id, row_number),
  UNIQUE (id, account_id)
)`,
    `CREATE INDEX raw_rows_account_id_idx ON raw_rows (account_id)`,
    `CREATE TABLE transactions (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  account_id text NOT NULL REFERENCES accounts (id),
  posted_date date NOT NULL,
  amount_minor_units bigint NOT NULL,
  currency text NOT NULL,
  description text NOT NULL,
  fee_minor_units bigint NOT NULL DEFAULT 0,
  balance_after_minor_units bigint,
  dedup_key text NOT NULL,
  original_currency text,
  original_amount_minor_units bigint,
  fx_fee_minor_units bigint,
  fx_fee_percent numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((original_currency IS NULL) = (original_amount_minor_units IS NULL)),
  CHECK ((fx_fee_minor_units IS NULL) = (fx_fee_percent IS NULL)),
  UNIQUE (account_id, dedup_key),
  UNIQUE (id, account_id)
)`,
    `CREATE TABLE transaction_sources (
  transaction_id text NOT NULL,
  raw_row_id text NOT NULL,
  account_id text NOT NULL,
  PRIMARY KEY (transaction_id, raw_row_id),
  FOREIGN KEY (transaction_id, account_id) REFERENCES transactions (id, account_id),
  FOREIGN KEY (raw_row_id, account_id) REFERENCES raw_rows (id, account_id)
)`,
    `CREATE INDEX transaction_sources_raw_row_id_idx ON transaction_sources (raw_row_id)`,
  ],
};
