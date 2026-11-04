import type { Migration } from './migration';

// FROZEN once applied. The retention sweep must try each message once even when
// two scheduled runs overlap, so due messages are claimed (with a lease) before
// they are processed, instead of merely read. A run that dies keeps its claims
// only for the lease; after that another run takes them over.
export const m0015: Migration = {
  id: '0015-claim-bot-messages',
  statements: [
    `ALTER TABLE bot_messages ADD COLUMN claimed_at timestamptz`,
    `CREATE FUNCTION draupnir.claim_due_bot_messages(p_limit integer)
  RETURNS TABLE (chat_id bigint, message_id bigint, sent_at timestamptz)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  UPDATE public.bot_messages m SET claimed_at = now()
   WHERE (m.chat_id, m.message_id) IN (
     SELECT b.chat_id, b.message_id FROM public.bot_messages b
      WHERE b.deleted_at IS NULL AND b.failed_at IS NULL
        AND b.sent_at < now() - interval '24 hours'
        AND (b.claimed_at IS NULL OR b.claimed_at < now() - interval '15 minutes')
      ORDER BY b.sent_at LIMIT p_limit
      FOR UPDATE SKIP LOCKED)
  RETURNING m.chat_id, m.message_id, m.sent_at
$$`,
    `REVOKE EXECUTE ON FUNCTION draupnir.claim_due_bot_messages(integer) FROM PUBLIC`,
    `GRANT EXECUTE ON FUNCTION draupnir.claim_due_bot_messages(integer) TO draupnir_app`,
  ],
};
