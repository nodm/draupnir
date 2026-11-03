import type { Migration } from './migration';

// FROZEN once applied. Follow-ups to 0005 from review:
//
// 1. Last owner. The generic owner write policies let an owner delete the final
//    owner row or demote it, leaving an account nobody can administer. A
//    trigger enforces the invariant in the database; it locks the remaining
//    owner rows so two owners can't remove each other concurrently.
// 2. statement_files visibility. Approved files are visible to members of the
//    upload account *or* of any account the file resolved to (so a rebuild of
//    an account whose rows came from another account's upload still sees the
//    file). The uploader branch applies to rejected files only, so a removed
//    member can't keep reading approved-file metadata.
const APP_ROLE = 'draupnir_app';

export const m0006: Migration = {
  id: '0006-rls-review-fixes',
  statements: [
    `CREATE FUNCTION draupnir.keep_last_owner() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_other integer;
BEGIN
  IF OLD.role = 'owner'
     AND (TG_OP = 'DELETE'
          OR NOT (NEW.role = 'owner' AND NEW.account_id = OLD.account_id AND NEW.user_id = OLD.user_id)) THEN
    SELECT 1 INTO v_other FROM public.account_members m
     WHERE m.account_id = OLD.account_id AND m.role = 'owner' AND m.user_id <> OLD.user_id
       FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'an account must keep at least one owner' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$`,
    `REVOKE EXECUTE ON FUNCTION draupnir.keep_last_owner() FROM PUBLIC`,
    `CREATE TRIGGER account_members_keep_last_owner
  BEFORE UPDATE OR DELETE ON account_members
  FOR EACH ROW EXECUTE FUNCTION draupnir.keep_last_owner()`,

    `CREATE FUNCTION draupnir.is_file_member(p_file_id text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$ SELECT EXISTS (
    SELECT 1 FROM public.statement_file_accounts fa
      JOIN public.account_members m ON m.account_id = fa.account_id
     WHERE fa.file_id = p_file_id AND m.user_id = draupnir.current_sub()
  ) $$`,
    `REVOKE EXECUTE ON FUNCTION draupnir.is_file_member(text) FROM PUBLIC`,
    `GRANT EXECUTE ON FUNCTION draupnir.is_file_member(text) TO ${APP_ROLE}`,
    `DROP POLICY statement_files_select ON statement_files`,
    `CREATE POLICY statement_files_select ON statement_files FOR SELECT TO ${APP_ROLE}
  USING (
    (status = 'rejected' AND uploaded_by = draupnir.current_sub())
    OR (status = 'approved'
        AND (draupnir.is_member(upload_account_id, 'viewer') OR draupnir.is_file_member(id)))
  )`,
  ],
};
