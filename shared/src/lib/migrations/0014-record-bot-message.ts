import type { Migration } from './migration';

// FROZEN once applied. Records a message the bot sent (or received) so the
// retention job can delete it later. The bot also writes to chats of people
// other than the caller (e.g. "X shared an account with you"), which the
// own-rows policy on `bot_messages` would refuse, so the owner of the row is
// derived from the link of that private chat (chat id = Telegram user id)
// instead of being passed in. A chat with no link records nothing.
export const m0014: Migration = {
  id: '0014-record-bot-message',
  statements: [
    `CREATE FUNCTION draupnir.record_bot_message(p_chat_id bigint, p_message_id bigint) RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  INSERT INTO public.bot_messages (chat_id, message_id, user_id)
  SELECT p_chat_id, p_message_id, l.user_id
    FROM public.messenger_links l WHERE l.telegram_user_id = p_chat_id
  ON CONFLICT (chat_id, message_id) DO NOTHING
$$`,
    `REVOKE EXECUTE ON FUNCTION draupnir.record_bot_message(bigint, bigint) FROM PUBLIC`,
    `GRANT EXECUTE ON FUNCTION draupnir.record_bot_message(bigint, bigint) TO draupnir_app`,
  ],
};
