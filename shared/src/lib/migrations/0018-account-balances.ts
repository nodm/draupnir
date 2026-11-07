import type { Migration } from './migration';

// FROZEN once applied. Expand step of the stored-balances change
// (docs/adr/0013).
//
// accounts: the three balance columns end up NOT NULL here. Existing accounts
// get their opening balance as of their opening date with reconciled = false
// (an unconfirmed placeholder that the backfill overwrites); list_accounts tells
// the model to flag an unreconciled balance. A trigger gives every new account
// the same starting values (its opening balance, reconciled), so no insert path
// can leave them empty.
//
// transactions: occurred_at, source_seq and running_balance_minor_units stay
// nullable until the backfill has run on prod; a later migration makes them
// NOT NULL. They cannot be derived in SQL (the order key comes from the raw
// rows). Nothing is dropped or rewritten.
export const m0018: Migration = {
  id: '0018-account-balances',
  statements: [
    `ALTER TABLE accounts
  ADD COLUMN balance_minor_units bigint,
  ADD COLUMN balance_as_of date,
  ADD COLUMN balance_reconciled boolean`,
    `UPDATE accounts
   SET balance_minor_units = opening_balance_minor_units,
       balance_as_of = opened_on,
       balance_reconciled = false`,
    `ALTER TABLE accounts
  ALTER COLUMN balance_minor_units SET NOT NULL,
  ALTER COLUMN balance_as_of SET NOT NULL,
  ALTER COLUMN balance_reconciled SET NOT NULL`,
    `CREATE FUNCTION draupnir.init_account_balance() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  NEW.balance_minor_units := COALESCE(NEW.balance_minor_units, NEW.opening_balance_minor_units);
  NEW.balance_as_of := COALESCE(NEW.balance_as_of, NEW.opened_on);
  NEW.balance_reconciled := COALESCE(NEW.balance_reconciled, true);
  RETURN NEW;
END $$`,
    `REVOKE EXECUTE ON FUNCTION draupnir.init_account_balance() FROM PUBLIC`,
    `CREATE TRIGGER accounts_init_balance BEFORE INSERT ON accounts
  FOR EACH ROW EXECUTE FUNCTION draupnir.init_account_balance()`,
    `ALTER TABLE transactions
  ADD COLUMN occurred_at timestamptz,
  ADD COLUMN source_seq integer,
  ADD COLUMN running_balance_minor_units bigint`,
    `CREATE INDEX transactions_account_order_idx
  ON transactions (account_id, occurred_at, source_seq, id)`,
  ],
};
