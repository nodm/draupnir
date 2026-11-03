import type { Migration } from './migration';

// FROZEN once applied. Database-enforced membership (docs: add-row-level-
// security). The `draupnir_app` login role is created by the migration runner
// (its password is not static SQL), so it exists before this runs.
//
// Identity: `app.sub` is set per transaction by withCaller (set_config(..., true));
// current_sub() is NULL without it, so every policy fails closed.
//
// Rule for every SECURITY DEFINER function: pinned search_path ending in
// pg_temp, schema-qualified references, EXECUTE only for draupnir_app.

const APP_ROLE = 'draupnir_app';

function enableRls(table: string): string {
  return `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`;
}

function select(table: string, using: string): string {
  return `CREATE POLICY ${table}_select ON ${table} FOR SELECT TO ${APP_ROLE} USING (${using})`;
}

// INSERT/UPDATE/DELETE, all owner-gated; WITH CHECK stops an update moving a
// row into an account the caller doesn't own.
function ownerWrites(table: string, ownerCheck: string): string[] {
  return [
    `CREATE POLICY ${table}_insert ON ${table} FOR INSERT TO ${APP_ROLE} WITH CHECK (${ownerCheck})`,
    `CREATE POLICY ${table}_update ON ${table} FOR UPDATE TO ${APP_ROLE} USING (${ownerCheck}) WITH CHECK (${ownerCheck})`,
    `CREATE POLICY ${table}_delete ON ${table} FOR DELETE TO ${APP_ROLE} USING (${ownerCheck})`,
  ];
}

const viewer = (col: string) => `draupnir.is_member(${col}, 'viewer')`;
const owner = (col: string) => `draupnir.is_member(${col}, 'owner')`;

export const m0005: Migration = {
  id: '0005-row-level-security',
  statements: [
    `CREATE SCHEMA draupnir`,
    `CREATE FUNCTION draupnir.current_sub() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.sub', true), '') $$`,
    // Runs as the table owner, which bypasses RLS, so policies on
    // account_members can call it without re-entering themselves.
    `CREATE FUNCTION draupnir.is_member(p_account_id text, p_min_role text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$ SELECT EXISTS (
    SELECT 1 FROM public.account_members m
     WHERE m.account_id = p_account_id
       AND m.user_id = draupnir.current_sub()
       AND (p_min_role = 'viewer' OR m.role = 'owner')
  ) $$`,
    // The only way the app role can insert into accounts.
    `CREATE FUNCTION draupnir.create_account(
  p_bank text, p_iban text, p_currency text, p_display_name text,
  p_opened_on date, p_opening_balance bigint
) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_sub text := draupnir.current_sub();
  v_id text;
BEGIN
  IF v_sub IS NULL THEN
    RAISE EXCEPTION 'no caller identified' USING ERRCODE = '28000';
  END IF;
  INSERT INTO public.accounts (bank, iban, currency, display_name, opened_on, opening_balance_minor_units)
  VALUES (p_bank, p_iban, p_currency, p_display_name, p_opened_on, p_opening_balance)
  RETURNING id INTO v_id;
  INSERT INTO public.account_members (account_id, user_id, role) VALUES (v_id, v_sub, 'owner');
  RETURN v_id;
END $$`,
    `REVOKE EXECUTE ON FUNCTION draupnir.current_sub() FROM PUBLIC`,
    `REVOKE EXECUTE ON FUNCTION draupnir.is_member(text, text) FROM PUBLIC`,
    `REVOKE EXECUTE ON FUNCTION draupnir.create_account(text, text, text, text, date, bigint) FROM PUBLIC`,
    `GRANT USAGE ON SCHEMA draupnir TO ${APP_ROLE}`,
    `GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`,
    `GRANT EXECUTE ON FUNCTION draupnir.current_sub() TO ${APP_ROLE}`,
    `GRANT EXECUTE ON FUNCTION draupnir.is_member(text, text) TO ${APP_ROLE}`,
    `GRANT EXECUTE ON FUNCTION draupnir.create_account(text, text, text, text, date, bigint) TO ${APP_ROLE}`,

    // schema_migrations is deliberately not granted.
    `GRANT SELECT, UPDATE, DELETE ON accounts TO ${APP_ROLE}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON account_members, statement_file_accounts, raw_rows, transactions, transaction_sources TO ${APP_ROLE}`,
    `GRANT SELECT, INSERT ON statement_files TO ${APP_ROLE}`,

    ...[
      'accounts',
      'account_members',
      'statement_files',
      'statement_file_accounts',
      'raw_rows',
      'transactions',
      'transaction_sources',
    ].map(enableRls),

    select('accounts', viewer('id')),
    `CREATE POLICY accounts_update ON accounts FOR UPDATE TO ${APP_ROLE} USING (${owner('id')}) WITH CHECK (${owner('id')})`,
    `CREATE POLICY accounts_delete ON accounts FOR DELETE TO ${APP_ROLE} USING (${owner('id')})`,

    select('account_members', viewer('account_id')),
    ...ownerWrites('account_members', owner('account_id')),

    // Rejection reasons can quote other accounts' rows, so rejected files stay
    // with their uploader; approved files are needed by every owner (rebuild,
    // duplicate check).
    select(
      'statement_files',
      `uploaded_by = draupnir.current_sub() OR (status = 'approved' AND ${viewer('upload_account_id')})`,
    ),
    `CREATE POLICY statement_files_insert ON statement_files FOR INSERT TO ${APP_ROLE}
  WITH CHECK (uploaded_by = draupnir.current_sub() AND ${owner('upload_account_id')})`,

    ...[
      'statement_file_accounts',
      'raw_rows',
      'transactions',
      'transaction_sources',
    ].flatMap((table) => [
      select(table, viewer('account_id')),
      ...ownerWrites(table, owner('account_id')),
    ]),
  ],
};
