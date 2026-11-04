import type { Migration } from './migration';

// FROZEN once applied. Lets the bot tell whether a Telegram user is mid-link
// (a confirmation code was issued and has not expired) without redeeming
// anything, so an unrelated message does not replace the pending request.
export const m0010: Migration = {
  id: '0010-bot-link-helpers',
  statements: [
    `CREATE FUNCTION draupnir.has_pending_link(p_telegram_user_id bigint) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$ SELECT EXISTS (
    SELECT 1 FROM public.link_requests r
     WHERE r.telegram_user_id = p_telegram_user_id
       AND r.pending_sub IS NOT NULL AND r.code_expires_at > now()
  ) $$`,
    `REVOKE EXECUTE ON FUNCTION draupnir.has_pending_link(bigint) FROM PUBLIC`,
    `GRANT EXECUTE ON FUNCTION draupnir.has_pending_link(bigint) TO draupnir_app`,
  ],
};
