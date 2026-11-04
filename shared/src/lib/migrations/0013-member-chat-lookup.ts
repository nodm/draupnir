import type { Migration } from './migration';

// FROZEN once applied. Lets an account owner notify a member in that member's
// own Telegram chat (/share, /unshare) without being able to read
// `messenger_links`, which RLS limits to each user's own row.
//
// Deliberately narrow: it answers only for a user who is a member of an
// account the caller owns, and returns nothing else about them. Private-chat
// ids equal Telegram user ids, so the id is also the chat id. Callers must look
// a member up while they are still a member (before removing them).
export const m0013: Migration = {
  id: '0013-member-chat-lookup',
  statements: [
    `CREATE FUNCTION draupnir.telegram_chat_of_member(p_account_id text, p_user_id text) RETURNS bigint
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$ SELECT l.telegram_user_id
          FROM public.messenger_links l
         WHERE l.user_id = p_user_id
           AND EXISTS (SELECT 1 FROM public.account_members t
                        WHERE t.account_id = p_account_id AND t.user_id = p_user_id)
           AND EXISTS (SELECT 1 FROM public.account_members o
                        WHERE o.account_id = p_account_id
                          AND o.user_id = draupnir.current_sub()
                          AND o.role = 'owner') $$`,
    `REVOKE EXECUTE ON FUNCTION draupnir.telegram_chat_of_member(text, text) FROM PUBLIC`,
    `GRANT EXECUTE ON FUNCTION draupnir.telegram_chat_of_member(text, text) TO draupnir_app`,
  ],
};
