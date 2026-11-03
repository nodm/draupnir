import type { Migration } from './migration';

// FROZEN once applied. A statement_file_accounts row makes its file visible to
// members of its account (0006's is_file_member), so the row must not be
// forgeable: an owner of any account could otherwise link someone else's file
// id to their own account and read that file's metadata.
//
// - INSERT additionally requires that the caller uploaded the file or owns its
//   upload account (checked by a SECURITY DEFINER helper, since the caller may
//   not be able to see the file row).
// - UPDATE is narrowed to the one column the application changes after the
//   import (rebuild refreshes new_transaction_count), so file_id and
//   account_id can't be rewritten to forge a link.
const APP_ROLE = 'draupnir_app';

export const m0007: Migration = {
  id: '0007-restrict-file-account-links',
  statements: [
    `CREATE FUNCTION draupnir.can_link_file(p_file_id text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$ SELECT EXISTS (
    SELECT 1 FROM public.statement_files f
     WHERE f.id = p_file_id
       AND (f.uploaded_by = draupnir.current_sub()
            OR draupnir.is_member(f.upload_account_id, 'owner'))
  ) $$`,
    `REVOKE EXECUTE ON FUNCTION draupnir.can_link_file(text) FROM PUBLIC`,
    `GRANT EXECUTE ON FUNCTION draupnir.can_link_file(text) TO ${APP_ROLE}`,
    `DROP POLICY statement_file_accounts_insert ON statement_file_accounts`,
    `CREATE POLICY statement_file_accounts_insert ON statement_file_accounts FOR INSERT TO ${APP_ROLE}
  WITH CHECK (draupnir.is_member(account_id, 'owner') AND draupnir.can_link_file(file_id))`,
    `REVOKE UPDATE ON statement_file_accounts FROM ${APP_ROLE}`,
    `GRANT UPDATE (new_transaction_count) ON statement_file_accounts TO ${APP_ROLE}`,
  ],
};
