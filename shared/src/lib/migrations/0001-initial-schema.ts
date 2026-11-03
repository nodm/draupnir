import type { Migration } from './migration';

// FROZEN: once applied anywhere, never edit — add a new migration instead.
// `IF NOT EXISTS` lets this adopt the live cluster, where `accounts` and
// `transactions` were created by hand and `share_grants` was never applied.
//
// account_id + owner_user_id is a composite FK against accounts(id,
// owner_user_id) (backed by that table's UNIQUE (id, owner_user_id)), not just
// account_id -> accounts(id) — a plain single-column FK would let a
// transaction claim owner_user_id B while pointing at an account owned by
// user A, which the ownership invariant must never allow.
export const m0001: Migration = {
  id: '0001-initial-schema',
  statements: [
    `CREATE TABLE IF NOT EXISTS accounts (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  owner_user_id text NOT NULL,
  bank text NOT NULL CHECK (bank IN ('seb', 'revolut', 'monobank')),
  iban text NOT NULL UNIQUE,
  currency text NOT NULL,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, owner_user_id)
)`,
    `CREATE TABLE IF NOT EXISTS transactions (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  owner_user_id text NOT NULL,
  account_id text NOT NULL,
  posted_date date NOT NULL,
  amount_minor_units bigint NOT NULL,
  currency text NOT NULL,
  description text NOT NULL,
  dedup_key text NOT NULL UNIQUE,
  original_currency text,
  original_amount_minor_units bigint,
  fx_fee_minor_units bigint,
  fx_fee_percent numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((original_currency IS NULL) = (original_amount_minor_units IS NULL)),
  CHECK ((fx_fee_minor_units IS NULL) = (fx_fee_percent IS NULL)),
  FOREIGN KEY (account_id, owner_user_id) REFERENCES accounts (id, owner_user_id)
)`,
    `CREATE TABLE IF NOT EXISTS share_grants (
  grantor_user_id text NOT NULL,
  grantee_user_id text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (grantee_user_id, resource_type, resource_id)
)`,
  ],
};
