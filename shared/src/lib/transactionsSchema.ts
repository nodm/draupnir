export const BANKS = ['seb', 'revolut', 'monobank'] as const;

export type Bank = (typeof BANKS)[number];

export const ACCOUNTS_TABLE_DDL = `
CREATE TABLE accounts (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  owner_user_id text NOT NULL,
  bank text NOT NULL CHECK (bank IN ('seb', 'revolut', 'monobank')),
  iban text NOT NULL UNIQUE,
  currency text NOT NULL,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
`.trim();

export const TRANSACTIONS_TABLE_DDL = `
CREATE TABLE transactions (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  owner_user_id text NOT NULL,
  account_id text NOT NULL REFERENCES accounts(id),
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
  CHECK ((fx_fee_minor_units IS NULL) = (fx_fee_percent IS NULL))
);
`.trim();
