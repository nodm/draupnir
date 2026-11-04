## Context

- Identity: Cognito user pool with Google federation and a pre-sign-up allowlist
  (`infra/lib/cognito.ts`, Managed Login). API routes use a `COGNITO_USER_POOLS`
  authorizer via `createLambdaRoute` (`infra/lib/lambdaRoute.ts`).
- After `add-row-level-security`, all data access goes through
  `withCaller(sub, …)` with the `draupnir_app` role, and every table needs RLS
  (guard test).
- Ingestion: S3 `uploads/{sub}/{accountId}/{uuid}.csv` → SQS → worker
  (`infra/lib/ingestionPipeline.ts`). Account creation and coverage logic live in
  `ingestion` after `redesign-statement-data-model`, which `bot` can't import
  (module boundaries).
- Telegram constraints:
  - Webhooks are retried when not answered promptly; deliveries carry
    `update_id`.
  - `setWebhook` accepts a `secret_token`, echoed in
    `X-Telegram-Bot-Api-Secret-Token`.
  - Bots may download files up to 20 MB via `getFile`.
  - `deleteMessage` works on messages younger than 48 hours, including
    incoming ones in private chats.
  - Deep-link `/start` payloads are limited to 64 characters `[A-Za-z0-9_-]`.

## Goals / Non-Goals

**Goals:**
- A complete Telegram-only interface for linking, upload, and account
  operations, built on the existing pipeline and identity.

**Non-Goals:**
- AI chat (`add-bot-ai-chat`). Free text currently gets a help reply.
- Group chats. The bot answers private chats only and ignores groups.
- Other messengers or a web app.
- Telegram Login Widget or Mini App. Google stays the identity; a Mini App
  can't host Google sign-in in its webview anyway.

## Decisions

### 1. Components

```
Telegram ──POST /telegram/webhook──▶ webhook λ ──▶ SQS FIFO (group = chat id, dedup = update_id)
                                                     │
                                                     ▼
                                         bot worker λ ──▶ Telegram API (sendMessage, getFile, deleteMessage)
                                           │    ▲  │
                                 S3 uploads/│    │  └─▶ Aurora (withCaller as linked sub)
                                           ▼    │
                         ingestion pipeline ──▶ outcome SQS ──┘ (same worker, second event source)
Browser ──GET /telegram/callback──▶ callback λ ──▶ Cognito token endpoint, Aurora, Telegram
EventBridge Scheduler (every 30 min) ──▶ retention λ ──▶ Telegram deleteMessage, Aurora
```

- **Webhook λ:** only checks the secret (`crypto.timingSafeEqual`) and does
  `SendMessage` to FIFO. It has no database access, keeping it fast even while
  Aurora resumes.
- **Why FIFO:** per-chat ordering for guided dialogues, plus 5-minute
  content dedup by `update_id`, covers Telegram retries. A longer-lived update
  table was considered and rejected: retries happen within seconds, and
  duplicate file imports are already rejected by the pipeline's SHA-256 rule.
- **Outcome delivery: transactional outbox.** Publishing to SQS after commit
  isn't enough. If the commit succeeds and the publish fails, a retry of the
  upload would hit the already-recorded file and the chat would never get the
  original outcome; suppressing the retry would lose the outcome instead.
  - Migration `0009` adds `statement_outcome_outbox(file_id PK, s3_key,
    payload jsonb, created_at, published_at NULL)`. The ingestion worker
    inserts the row **in the same transaction** that commits the file's
    outcome.
  - After commit it publishes to the outcome queue and sets `published_at`.
  - A scheduled sweeper (the retention λ's schedule, every 30 min, plus once
    right after each ingestion run) re-publishes rows still unpublished after
    1 minute.
  - Redelivered upload messages re-emit the recorded outcome
    (`redesign-statement-data-model` design, decision 3b), so a retry never
    turns into a duplicate rejection.
  - Delivery is at-least-once, and two workers can receive the same outcome
    at the same time, so reporting uses an **atomic claim with a lease**
    instead of a "was it reported?" check:
    - `bot_pending_uploads` has `report_state` (`pending` | `claimed` |
      `reported`) and `report_claimed_at`.
    - `draupnir.claim_outcome_report(s3_key)` runs a single
      `UPDATE … SET report_state = 'claimed', report_claimed_at = now()
      WHERE s3_key = :k AND (report_state = 'pending' OR (report_state =
      'claimed' AND report_claimed_at < now() - interval '2 minutes'))
      RETURNING chat_id, message_id`. Row-level locking means exactly one
      concurrent caller gets a row back. The others get nothing and drop the
      message.
    - The winner sends the report, then sets `report_state = 'reported'`.
    - If a worker crashes after claiming but before sending, the 2-minute
      lease expires and the SQS redelivery (visibility timeout longer than
      the lease) claims and sends it.
    - Residual risk, accepted: a crash after `sendMessage` succeeds but before
      `reported` is written can produce one duplicate report after the lease
      expires. Telegram's `sendMessage` has no idempotency key, and a
      duplicate notice is harmless; a lost one is not.
  - The outbox is accessed only through `SECURITY DEFINER` functions, since
    the sweeper has no user identity (see the RLS table in decision 3).
  - SNS fan-out was considered, but there is one consumer; it is easy to insert
    behind the outbox later.

### 2. Linking flow

1. Unlinked user writes → the worker creates a 32-byte random state, stores
   `sha256(state)` with Telegram user id, chat id, Telegram display name, and
   `expires_at = now + 10 min` in `link_requests`, and replies with the Cognito
   authorize URL (`response_type=code`, `scope=openid email`, PKCE `S256`,
   `state=<state>`, `redirect_uri=<api>/telegram/callback`).
2. Callback λ:
   - consumes the state atomically: a `SECURITY DEFINER` function marks it
     used and returns the request, only if unexpired and unused;
   - exchanges the code with the confidential app client (secret in Secrets
     Manager, plus the PKCE verifier stored with the request);
   - verifies the ID token (`aws-jwt-verify`) and reads `sub` and `email`;
   - **does not link yet**: it stores a *pending* link (`sub`, `email`) on the
     request with a fresh 6-digit confirmation code (hashed, valid 5 minutes,
     at most 5 attempts);
   - renders a page showing the Telegram account that asked to link (display
     name and @username), the code, and the instruction "send this code to
     @DraupnirBot from that Telegram account. Never share it with anyone."
3. The originating Telegram user sends the code. The worker checks it against
   the pending link of **that** Telegram user only. If it matches, it inserts
   into `messenger_links` (both columns unique) and confirms in the chat with
   the linked email. Wrong codes count attempts; the 5th wrong attempt or
   expiry cancels the request.
4. A new Cognito app client (`draupnir-telegram`) with only that callback URL
   reuses the pool's Google IdP and pre-sign-up trigger, so the allowlist
   applies unchanged. Like the existing `draupnir-app` client
   (`infra/lib/cognito.ts`), it needs its own `aws.cognito.ManagedLoginBranding`
   (`useCognitoProvidedValues: true`, `dependsOn` the domain). Managed Login v2
   doesn't assign a branding style to a new client, and without one the
   sign-in URL is unusable.

**Why the confirmation code:** state and PKCE bind the OAuth round-trip, not
the two identities. Without the code, an attacker could send `/start`, forward
their sign-in link to an allowlisted user who hasn't linked yet, and gain chat
access to that user's data once they sign in. With the code, completing sign-in
alone links nothing. The code appears only in the signed-in browser and is
accepted only from the Telegram account that started the request. The attacker
would also need the victim to read the code out to them, and the page shows
whose Telegram account is asking and warns against exactly that.

### 3. Data access and RLS for bot tables (migration `0009`)

| Table | Purpose | RLS |
|---|---|---|
| `messenger_links(telegram_user_id UNIQUE, user_id UNIQUE, email, linked_at)` | identity | `user_id = current_sub()`; lookup by Telegram id only through `SECURITY DEFINER draupnir.sub_for_telegram_user()` |
| `link_requests(state_hash PK, telegram_user_id, chat_id, telegram_display_name, pkce_verifier, expires_at, used_at, pending_sub, pending_email, code_hash, code_expires_at, code_attempts)` | pending links | no direct access (`USING (false)`); create/consume through `SECURITY DEFINER` functions |
| `bot_conversations(user_id PK, kind, state jsonb, expires_at)` | guided-dialogue state | `user_id = current_sub()` |
| `bot_pending_uploads(id, user_id, chat_id, message_id, telegram_file_id, s3_key NULL UNIQUE, expires_at, report_state, report_claimed_at NULL)` | account choice and outcome routing | `user_id = current_sub()`; the outcome consumer claims by `s3_key` only through `SECURITY DEFINER draupnir.claim_outcome_report()` / `draupnir.mark_outcome_reported()` |
| `bot_messages(chat_id, message_id, user_id, sent_at, deleted_at, failed_at)` | retention | `user_id = current_sub()`; retention job uses `SECURITY DEFINER` due/mark functions |
| `statement_outcome_outbox(file_id PK FK, s3_key, uploaded_by, payload jsonb, created_at, published_at NULL)` | outcome outbox | RLS enabled with a deny-all policy (`USING (false) WITH CHECK (false)`); **no** table privileges granted to `draupnir_app`. Access only through `SECURITY DEFINER` functions: `draupnir.enqueue_outcome(file_id, payload)` (inserts only if `statement_files.uploaded_by = draupnir.current_sub()` for that file, so it runs inside the uploader's import transaction), `draupnir.due_outcomes(limit)` (unpublished rows older than 1 minute, for the sweeper), `draupnir.mark_outcome_published(file_id)` |

All functions above follow `add-row-level-security`'s `SECURITY DEFINER` rule
(`search_path = pg_catalog, pg_temp`, schema-qualified, EXECUTE only for
`draupnir_app`), so both guard tests (RLS on every table, pinned search path)
pass with no exceptions.

The worker first resolves `sub` from the Telegram user id, then runs everything
else in `withCaller(sub, …)`.

### 4. Shared domain functions

Bot commands need account creation, membership changes, account listing, and
coverage, which `ingestion` owns after the redesign. These move to `shared`
(`shared/src/lib/accounts/`), and both `ingestion` and `bot` call them. This is
the module-boundary rule's "anything apps share belongs in `scope:shared`".

### 5. Telegram API client

There is no bot framework. A small `fetch` wrapper covers:
- `sendMessage`, `editMessageReplyMarkup`, `answerCallbackQuery`;
- `getFile` + download;
- `deleteMessage`, `sendChatAction`.

Types come from `@grammyjs/types`. A framework (grammY, Telegraf) was considered.
It is useful for long polling and middleware, but the webhook → queue → worker
split means only the update types and about 7 methods are needed. The bot token
is read from Secrets Manager once per cold start.

### 6. Dialogue state

Guided commands (`/newaccount`, `/share`) store `{kind, step, answers}` in
`bot_conversations` with a 1-hour expiry. Button presses carry short callback
data (`acct:<n>`, `confirm`, `cancel`), resolved against the stored state rather
than embedding ids, which keeps them under Telegram's 64-byte limit.

### 7. Sharing by email

`/share` resolves the email to a `sub` with Cognito `ListUsers`
(`filter: email = "…"`). The worker role is granted `cognito-idp:ListUsers` on
this pool only. Using `messenger_links.email` alone was considered, but it would
make sharing require the other person to have linked Telegram first, rather than
just having signed in.

### 8. Retention

`bot_messages` rows are written for every financial message sent. The retention
λ runs every 30 minutes and deletes messages older than 24 hours. Any delete
error marks `failed_at` and logs, with no retry, so a missed 48-hour window is
reported instead of looping. The uploaded document is deleted right after the
outcome reply.

## Risks / Trade-offs

- **The public webhook URL is discoverable.** → The secret header plus
  constant-time compare; non-matching requests never reach the queue.
- **Telegram stores chats in its cloud.** → The retention rules in this change.
  The user accepted the remaining exposure (ADR-0009).
- **A Cognito confidential client secret lives in Secrets Manager.** → Read only
  by the callback λ.
- **SEB IBAN auto-detection guesses wrong for multi-account files.** →
  Auto-select only when the header IBAN matches exactly one owned account;
  per-row resolution still validates every row (`account-management`).
- **Moving account functions to `shared` touches `ingestion`.** → No behavior
  change; covered by the existing ingestion tests.

## Migration Plan

1. Requires `redesign-statement-data-model` and `add-row-level-security`.
2. Manual: create the bot with BotFather and put its token into the
   Pulumi-created secret.
3. `infra:up` (migration `0009`, Lambdas, queues, routes, app client), then
   `pnpm exec nx run bot:set-webhook` registers the URL and secret token.
4. Rollback: `deleteWebhook`. The bot tables can stay; ingestion is unaffected
   apart from the outcome publish.
