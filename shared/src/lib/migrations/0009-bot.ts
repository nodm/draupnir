import type { Migration } from './migration';

// FROZEN once applied. Tables for the Telegram bot (openspec: add-telegram-bot,
// design decision 3). Same rules as 0005: every table has RLS and a policy;
// every SECURITY DEFINER function pins `search_path = pg_catalog, pg_temp`,
// schema-qualifies what it touches, and is executable by `draupnir_app` only.
//
// Tables that are reached before an identity exists (`link_requests`) or by
// jobs with no user identity (`statement_outcome_outbox`) get a deny-all
// policy and no grants; they are reachable only through the functions below.

const APP_ROLE = 'draupnir_app';

const own = `user_id = draupnir.current_sub()`;

function denyAll(table: string): string {
  return `CREATE POLICY ${table}_deny_all ON ${table} FOR ALL TO ${APP_ROLE} USING (false) WITH CHECK (false)`;
}

// `signature` is the argument-type list, e.g. 'bigint, text'.
function expose(name: string, signature: string): string[] {
  const fn = `draupnir.${name}(${signature})`;
  return [
    `REVOKE EXECUTE ON FUNCTION ${fn} FROM PUBLIC`,
    `GRANT EXECUTE ON FUNCTION ${fn} TO ${APP_ROLE}`,
  ];
}

const definer = `SECURITY DEFINER SET search_path = pg_catalog, pg_temp`;

export const m0009: Migration = {
  id: '0009-bot',
  statements: [
    // --- identity --------------------------------------------------------
    `CREATE TABLE messenger_links (
  telegram_user_id bigint NOT NULL UNIQUE,
  user_id text NOT NULL UNIQUE,
  email text NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now()
)`,
    `CREATE TABLE link_requests (
  state_hash text PRIMARY KEY,
  telegram_user_id bigint NOT NULL UNIQUE,
  chat_id bigint NOT NULL,
  telegram_display_name text NOT NULL,
  telegram_username text,
  pkce_verifier text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  pending_sub text,
  pending_email text,
  code_hash text,
  code_expires_at timestamptz,
  code_attempts integer NOT NULL DEFAULT 0
)`,
    // --- dialogue and upload state --------------------------------------
    `CREATE TABLE bot_conversations (
  user_id text PRIMARY KEY,
  kind text NOT NULL,
  state jsonb NOT NULL,
  expires_at timestamptz NOT NULL
)`,
    `CREATE TABLE bot_pending_uploads (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id text NOT NULL,
  chat_id bigint NOT NULL,
  message_id bigint NOT NULL,
  telegram_file_id text NOT NULL,
  s3_key text UNIQUE,
  expires_at timestamptz NOT NULL,
  report_state text NOT NULL DEFAULT 'pending'
    CHECK (report_state IN ('pending', 'claimed', 'reported')),
  report_claimed_at timestamptz
)`,
    `CREATE INDEX bot_pending_uploads_user_id_idx ON bot_pending_uploads (user_id)`,
    `CREATE TABLE bot_messages (
  chat_id bigint NOT NULL,
  message_id bigint NOT NULL,
  user_id text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  failed_at timestamptz,
  PRIMARY KEY (chat_id, message_id)
)`,
    `CREATE INDEX bot_messages_due_idx ON bot_messages (sent_at)
  WHERE deleted_at IS NULL AND failed_at IS NULL`,
    // --- outcome outbox --------------------------------------------------
    `CREATE TABLE statement_outcome_outbox (
  file_id text PRIMARY KEY REFERENCES statement_files (id),
  s3_key text NOT NULL,
  uploaded_by text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
)`,

    ...[
      'messenger_links',
      'link_requests',
      'bot_conversations',
      'bot_pending_uploads',
      'bot_messages',
      'statement_outcome_outbox',
    ].map((t) => `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`),

    // A linked user sees and removes only their own link; creating one goes
    // through redeem_link_code.
    `GRANT SELECT, DELETE ON messenger_links TO ${APP_ROLE}`,
    `CREATE POLICY messenger_links_select ON messenger_links FOR SELECT TO ${APP_ROLE} USING (${own})`,
    `CREATE POLICY messenger_links_delete ON messenger_links FOR DELETE TO ${APP_ROLE} USING (${own})`,

    denyAll('link_requests'),
    denyAll('statement_outcome_outbox'),

    `GRANT SELECT, INSERT, UPDATE, DELETE ON bot_conversations, bot_pending_uploads, bot_messages TO ${APP_ROLE}`,
    ...['bot_conversations', 'bot_pending_uploads', 'bot_messages'].map(
      (t) =>
        `CREATE POLICY ${t}_own ON ${t} FOR ALL TO ${APP_ROLE} USING (${own}) WITH CHECK (${own})`,
    ),

    // --- linking functions ----------------------------------------------
    `CREATE FUNCTION draupnir.sub_for_telegram_user(p_telegram_user_id bigint) RETURNS text
  LANGUAGE sql STABLE ${definer}
  AS $$ SELECT l.user_id FROM public.messenger_links l WHERE l.telegram_user_id = p_telegram_user_id $$`,

    // A new request replaces any earlier one for the same Telegram user.
    `CREATE FUNCTION draupnir.create_link_request(
  p_state_hash text, p_telegram_user_id bigint, p_chat_id bigint,
  p_display_name text, p_username text, p_pkce_verifier text, p_expires_at timestamptz
) RETURNS void
  LANGUAGE plpgsql VOLATILE ${definer}
  AS $$
BEGIN
  DELETE FROM public.link_requests WHERE telegram_user_id = p_telegram_user_id;
  INSERT INTO public.link_requests
    (state_hash, telegram_user_id, chat_id, telegram_display_name, telegram_username, pkce_verifier, expires_at)
  VALUES (p_state_hash, p_telegram_user_id, p_chat_id, p_display_name, p_username, p_pkce_verifier, p_expires_at);
END $$`,

    // Marks the state used and returns the request, only while unused and
    // unexpired: the second call (or a call after expiry) gets no row.
    `CREATE FUNCTION draupnir.consume_link_state(p_state_hash text)
  RETURNS TABLE (telegram_user_id bigint, chat_id bigint, display_name text, username text, pkce_verifier text)
  LANGUAGE sql VOLATILE ${definer}
  AS $$
  UPDATE public.link_requests r SET used_at = now()
   WHERE r.state_hash = p_state_hash AND r.used_at IS NULL AND r.expires_at > now()
  RETURNING r.telegram_user_id, r.chat_id, r.telegram_display_name, r.telegram_username, r.pkce_verifier
$$`,

    // Stores the verified identity as a *pending* link with a confirmation
    // code (5 minutes, 5 attempts). Links nothing.
    `CREATE FUNCTION draupnir.set_pending_link(
  p_state_hash text, p_sub text, p_email text, p_code_hash text
) RETURNS text
  LANGUAGE plpgsql VOLATILE ${definer}
  AS $$
DECLARE
  v_telegram_user_id bigint;
BEGIN
  SELECT r.telegram_user_id INTO v_telegram_user_id
    FROM public.link_requests r
   WHERE r.state_hash = p_state_hash AND r.used_at IS NOT NULL AND r.pending_sub IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN RETURN 'invalid'; END IF;
  IF EXISTS (SELECT 1 FROM public.messenger_links l WHERE l.user_id = p_sub) THEN
    RETURN 'sub_already_linked';
  END IF;
  IF EXISTS (SELECT 1 FROM public.messenger_links l WHERE l.telegram_user_id = v_telegram_user_id) THEN
    RETURN 'telegram_already_linked';
  END IF;
  UPDATE public.link_requests r
     SET pending_sub = p_sub, pending_email = p_email, code_hash = p_code_hash,
         code_expires_at = now() + interval '5 minutes', code_attempts = 0
   WHERE r.state_hash = p_state_hash;
  RETURN 'ok';
END $$`,

    // Checks the code against the pending link of *this* Telegram user only.
    // status: linked | wrong | cancelled (5th wrong attempt) | expired |
    // already_linked | none.
    `CREATE FUNCTION draupnir.redeem_link_code(p_telegram_user_id bigint, p_code_hash text)
  RETURNS TABLE (status text, linked_email text)
  LANGUAGE plpgsql VOLATILE ${definer}
  AS $$
DECLARE
  v public.link_requests%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.link_requests r
   WHERE r.telegram_user_id = p_telegram_user_id AND r.pending_sub IS NOT NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'none'::text, NULL::text; RETURN;
  END IF;
  IF v.code_expires_at <= now() THEN
    DELETE FROM public.link_requests r WHERE r.state_hash = v.state_hash;
    RETURN QUERY SELECT 'expired'::text, NULL::text; RETURN;
  END IF;
  IF v.code_hash = p_code_hash THEN
    BEGIN
      INSERT INTO public.messenger_links (telegram_user_id, user_id, email)
      VALUES (v.telegram_user_id, v.pending_sub, v.pending_email);
    EXCEPTION WHEN unique_violation THEN
      DELETE FROM public.link_requests r WHERE r.state_hash = v.state_hash;
      RETURN QUERY SELECT 'already_linked'::text, NULL::text; RETURN;
    END;
    DELETE FROM public.link_requests r WHERE r.state_hash = v.state_hash;
    RETURN QUERY SELECT 'linked'::text, v.pending_email; RETURN;
  END IF;
  IF v.code_attempts + 1 >= 5 THEN
    DELETE FROM public.link_requests r WHERE r.state_hash = v.state_hash;
    RETURN QUERY SELECT 'cancelled'::text, NULL::text; RETURN;
  END IF;
  UPDATE public.link_requests r SET code_attempts = r.code_attempts + 1 WHERE r.state_hash = v.state_hash;
  RETURN QUERY SELECT 'wrong'::text, NULL::text;
END $$`,

    // --- outcome reporting ----------------------------------------------
    // Exactly one caller gets a row: the winner of the row lock. A claim older
    // than the 2-minute lease can be taken again (crash after claiming).
    `CREATE FUNCTION draupnir.claim_outcome_report(p_s3_key text)
  RETURNS TABLE (chat_id bigint, message_id bigint)
  LANGUAGE sql VOLATILE ${definer}
  AS $$
  UPDATE public.bot_pending_uploads u
     SET report_state = 'claimed', report_claimed_at = now()
   WHERE u.s3_key = p_s3_key
     AND (u.report_state = 'pending'
          OR (u.report_state = 'claimed' AND u.report_claimed_at < now() - interval '2 minutes'))
  RETURNING u.chat_id, u.message_id
$$`,
    `CREATE FUNCTION draupnir.mark_outcome_reported(p_s3_key text) RETURNS void
  LANGUAGE sql VOLATILE ${definer}
  AS $$
  UPDATE public.bot_pending_uploads u SET report_state = 'reported'
   WHERE u.s3_key = p_s3_key AND u.report_state = 'claimed'
$$`,

    // --- retention -------------------------------------------------------
    `CREATE FUNCTION draupnir.due_bot_messages(p_limit integer)
  RETURNS TABLE (chat_id bigint, message_id bigint, sent_at timestamptz)
  LANGUAGE sql STABLE ${definer}
  AS $$
  SELECT m.chat_id, m.message_id, m.sent_at FROM public.bot_messages m
   WHERE m.deleted_at IS NULL AND m.failed_at IS NULL AND m.sent_at < now() - interval '24 hours'
   ORDER BY m.sent_at LIMIT p_limit
$$`,
    `CREATE FUNCTION draupnir.mark_bot_message_deleted(p_chat_id bigint, p_message_id bigint) RETURNS void
  LANGUAGE sql VOLATILE ${definer}
  AS $$ UPDATE public.bot_messages m SET deleted_at = now() WHERE m.chat_id = p_chat_id AND m.message_id = p_message_id $$`,
    `CREATE FUNCTION draupnir.mark_bot_message_failed(p_chat_id bigint, p_message_id bigint) RETURNS void
  LANGUAGE sql VOLATILE ${definer}
  AS $$ UPDATE public.bot_messages m SET failed_at = now() WHERE m.chat_id = p_chat_id AND m.message_id = p_message_id $$`,

    // --- outbox ----------------------------------------------------------
    // Runs inside the uploader's import transaction; refuses any file the
    // caller did not upload. Idempotent per file.
    `CREATE FUNCTION draupnir.enqueue_outcome(p_file_id text, p_payload jsonb) RETURNS void
  LANGUAGE plpgsql VOLATILE ${definer}
  AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.statement_files f
     WHERE f.id = p_file_id AND f.uploaded_by = draupnir.current_sub()
  ) THEN
    RAISE EXCEPTION 'file was not uploaded by the caller' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.statement_outcome_outbox (file_id, s3_key, uploaded_by, payload)
  SELECT f.id, f.s3_key, f.uploaded_by, p_payload FROM public.statement_files f WHERE f.id = p_file_id
  ON CONFLICT (file_id) DO NOTHING;
END $$`,
    `CREATE FUNCTION draupnir.due_outcomes(p_limit integer)
  RETURNS TABLE (file_id text, s3_key text, uploaded_by text, payload jsonb)
  LANGUAGE sql STABLE ${definer}
  AS $$
  SELECT o.file_id, o.s3_key, o.uploaded_by, o.payload FROM public.statement_outcome_outbox o
   WHERE o.published_at IS NULL AND o.created_at < now() - interval '1 minute'
   ORDER BY o.created_at LIMIT p_limit
$$`,
    `CREATE FUNCTION draupnir.mark_outcome_published(p_file_id text) RETURNS void
  LANGUAGE sql VOLATILE ${definer}
  AS $$ UPDATE public.statement_outcome_outbox o SET published_at = now() WHERE o.file_id = p_file_id $$`,

    ...expose('sub_for_telegram_user', 'bigint'),
    ...expose(
      'create_link_request',
      'text, bigint, bigint, text, text, text, timestamptz',
    ),
    ...expose('consume_link_state', 'text'),
    ...expose('set_pending_link', 'text, text, text, text'),
    ...expose('redeem_link_code', 'bigint, text'),
    ...expose('claim_outcome_report', 'text'),
    ...expose('mark_outcome_reported', 'text'),
    ...expose('due_bot_messages', 'integer'),
    ...expose('mark_bot_message_deleted', 'bigint, bigint'),
    ...expose('mark_bot_message_failed', 'bigint, bigint'),
    ...expose('enqueue_outcome', 'text, jsonb'),
    ...expose('due_outcomes', 'integer'),
    ...expose('mark_outcome_published', 'text'),
  ],
};
