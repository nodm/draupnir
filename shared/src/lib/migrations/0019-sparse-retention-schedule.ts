import type { Migration } from './migration';

// FROZEN once applied. The scheduled retention run went from hourly to every
// 12 hours by default (at most 13, enforced by infra/lib/bot.ts), so the two
// windows that assumed an hourly run are widened. Each must survive one missed
// or failed run, because the schedule never retries.
//
// claim_due_bot_messages: due after 20 hours, not 24. Deleted by the first run
// after that: 20-32 hours normally, under 44 hours after one missed run (46 at
// the 13-hour cap), always before Telegram's 48-hour deletion limit. 24 hours
// plus two 12-hour periods is exactly 48. Keep DELETE_AFTER_HOURS in
// infra/lib/bot.ts equal to this interval.
//
// unreported_outcomes: republished for 48 hours after commit, not 24. Eligible
// from 1 hour after each publication, so a 12-hourly run gets at least
// floor(47 / 12) = 3 attempts, and 2 after one missed run.
//
// Only the intervals change. CREATE OR REPLACE keeps the owner and grants; they
// are restated so this migration says on its own who may call these.
export const m0019: Migration = {
  id: '0019-sparse-retention-schedule',
  statements: [
    `CREATE OR REPLACE FUNCTION draupnir.claim_due_bot_messages(p_limit integer)
  RETURNS TABLE (chat_id bigint, message_id bigint, sent_at timestamptz)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  UPDATE public.bot_messages m SET claimed_at = now()
   WHERE (m.chat_id, m.message_id) IN (
     SELECT b.chat_id, b.message_id FROM public.bot_messages b
      WHERE b.deleted_at IS NULL AND b.failed_at IS NULL
        AND b.sent_at < now() - interval '20 hours'
        AND (b.claimed_at IS NULL OR b.claimed_at < now() - interval '15 minutes')
      ORDER BY b.sent_at LIMIT p_limit
      FOR UPDATE SKIP LOCKED)
  RETURNING m.chat_id, m.message_id, m.sent_at
$$`,
    `REVOKE EXECUTE ON FUNCTION draupnir.claim_due_bot_messages(integer) FROM PUBLIC`,
    `GRANT EXECUTE ON FUNCTION draupnir.claim_due_bot_messages(integer) TO draupnir_app`,
    `CREATE OR REPLACE FUNCTION draupnir.unreported_outcomes(p_limit integer)
  RETURNS TABLE (file_id text, payload jsonb)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT o.file_id, o.payload FROM public.statement_outcome_outbox o
   WHERE o.published_at < now() - interval '1 hour'
     AND o.created_at > now() - interval '48 hours'
     AND EXISTS (SELECT 1 FROM public.bot_pending_uploads p
                  WHERE p.s3_key = o.s3_key AND p.report_state <> 'reported')
   ORDER BY o.published_at LIMIT p_limit
$$`,
    `REVOKE EXECUTE ON FUNCTION draupnir.unreported_outcomes(integer) FROM PUBLIC`,
    `GRANT EXECUTE ON FUNCTION draupnir.unreported_outcomes(integer) TO draupnir_app`,
  ],
};
