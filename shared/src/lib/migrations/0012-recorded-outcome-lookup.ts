import type { Migration } from './migration';

// FROZEN once applied. Lets the pipeline recover the outcome it already
// committed for an S3 object even when row-level security hides the file from
// the uploader (they were removed from the account since). Without it, a
// redelivered upload would be re-judged as "not an owner" and could be reported
// as rejected while the committed approval is still waiting to be published.
//
// Scoped to the uploader: the worker runs as the sub in the object key, and the
// payload is returned only for a file that sub uploaded.
export const m0012: Migration = {
  id: '0012-recorded-outcome-lookup',
  statements: [
    `CREATE FUNCTION draupnir.recorded_outcome(p_s3_key text) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$ SELECT o.payload FROM public.statement_outcome_outbox o
         WHERE o.s3_key = p_s3_key AND o.uploaded_by = draupnir.current_sub() $$`,
    `REVOKE EXECUTE ON FUNCTION draupnir.recorded_outcome(text) FROM PUBLIC`,
    `GRANT EXECUTE ON FUNCTION draupnir.recorded_outcome(text) TO draupnir_app`,
  ],
};
