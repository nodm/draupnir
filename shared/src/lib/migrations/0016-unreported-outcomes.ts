import type { Migration } from './migration';

// FROZEN once applied. An outcome can be published to the queue and still never
// reach the chat: the worker may fail every delivery and the queue then moves it
// to its dead-letter queue, and the outbox row is already marked published. This
// lists those outcomes so the scheduled run can publish them again: published
// more than an hour ago, committed within the last 24 hours, and the upload they
// belong to still not reported. Republishing marks the row published again, so a
// message that keeps failing is retried once an hour, for a day, and then left.
//
// Reporting is idempotent (claim_outcome_report), so a republished outcome that
// was in fact reported meanwhile is dropped without a second message.
export const m0016: Migration = {
  id: '0016-unreported-outcomes',
  statements: [
    `CREATE FUNCTION draupnir.unreported_outcomes(p_limit integer)
  RETURNS TABLE (file_id text, payload jsonb)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT o.file_id, o.payload FROM public.statement_outcome_outbox o
   WHERE o.published_at < now() - interval '1 hour'
     AND o.created_at > now() - interval '24 hours'
     AND EXISTS (SELECT 1 FROM public.bot_pending_uploads p
                  WHERE p.s3_key = o.s3_key AND p.report_state <> 'reported')
   ORDER BY o.published_at LIMIT p_limit
$$`,
    `REVOKE EXECUTE ON FUNCTION draupnir.unreported_outcomes(integer) FROM PUBLIC`,
    `GRANT EXECUTE ON FUNCTION draupnir.unreported_outcomes(integer) TO draupnir_app`,
  ],
};
