import type { Migration } from './migration';

// FROZEN once applied. 0007 also let the file's uploader link it, but an
// uploader who has since left the upload account could then re-expose that
// file to an account they own. Linking requires current ownership of the upload
// account in every case; the worker only links files it just inserted, which
// already required that ownership.
export const m0008: Migration = {
  id: '0008-link-requires-upload-account-owner',
  statements: [
    `CREATE OR REPLACE FUNCTION draupnir.can_link_file(p_file_id text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$ SELECT EXISTS (
    SELECT 1 FROM public.statement_files f
     WHERE f.id = p_file_id
       AND draupnir.is_member(f.upload_account_id, 'owner')
  ) $$`,
  ],
};
