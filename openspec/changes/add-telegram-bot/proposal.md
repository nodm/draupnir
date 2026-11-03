## Why

Draupnir has no user interface: accounts are created with raw API calls and
statements are uploaded through presigned URLs by hand. The chosen interface is
a Telegram bot only, with no web app. Sharing a CSV from a banking app to a
Telegram chat works the same on Android and iPhone (the two users have one of
each), and the same chat will later host the AI assistant (`add-bot-ai-chat`).
Google, through the existing Cognito pool and allowlist, stays the identity;
Telegram is a linked channel.

Depends on `redesign-statement-data-model` (accounts, membership, file
outcomes) and `add-row-level-security` (all bot data access runs as the linked
user).

## What Changes

- New Nx project `bot` (`scope:bot`, `type:app`) with Lambdas for:
  - the webhook;
  - an SQS worker;
  - the Google sign-in callback;
  - a scheduled retention job.
- **Linking**:
  - `/start` from an unlinked Telegram user returns a one-time sign-in link
    (valid 10 minutes) to Cognito's hosted login with Google.
  - After sign-in, the browser shows a one-time confirmation code and which
    Telegram account asked. The link (`telegram_user_id ↔ sub`) is created
    only when that same Telegram account sends the code to the bot, so a
    forwarded sign-in link can't hand someone else's data to the forwarder.
  - The new Cognito app client gets its own Managed Login branding, which
    Managed Login v2 requires per client.
  - `/unlink` removes the link.
  - Unlinked users can do nothing except link.
- **Webhook**:
  - A public endpoint verifies Telegram's secret header, acknowledges
    immediately, and queues the update.
  - Updates for one chat are processed in order and each update at most once
    within the dedup window.
- **Statement upload**:
  - A CSV sent to the bot is attached to an account the user owns: picked
    from buttons, or detected from an SEB file's IBAN.
  - The file is stored at `uploads/{sub}/{accountId}/…` and goes through the
    existing pipeline.
  - The bot reports approval, rejection reasons, and coverage warnings.
- **Account commands**:
  - `/accounts` lists accounts with role and coverage.
  - `/newaccount` is a guided creation (bank, IBAN, currency, name, opening
    date, opening balance, confirm).
  - `/share` and `/unshare` add or remove a member by their Draupnir email,
    owner only.
  - `/coverage` shows covered periods and gaps.
- **Retention**:
  - The uploaded file message is deleted after its outcome is reported.
  - Bot messages containing financial data are deleted after 24 hours.
- **Pipeline outcome publishing**: the ingestion worker records each file's
  outcome in a transactional outbox in the same commit, then publishes it to a
  queue, independent of channel. A sweeper re-publishes anything left
  unpublished, and the bot reports each file once.
- ADR-0009: Telegram as the only interface.

## Capabilities

### New Capabilities
- `telegram-account-linking`: binding a Telegram user to a Google/Cognito
  identity, and unlinking.
- `telegram-bot-webhook`: authenticating, acknowledging, ordering, and
  de-duplicating incoming Telegram updates.
- `telegram-statement-upload`: receiving statement files in chat, account
  selection, handing off to ingestion, and reporting outcomes.
- `telegram-account-commands`: account listing, creation, sharing, and
  coverage through bot commands.
- `telegram-message-retention`: automatic deletion of uploaded files and of
  bot messages with financial data.

### Modified Capabilities
- `module-boundary-enforcement`: adds `scope:bot` (may depend on
  `scope:shared` only; `ingestion`, `mcp`, and `bot` don't depend on each
  other).
- `statement-ingestion-pipeline`: adds publishing of each processed file's
  outcome.

## Impact

- New `bot/` project:
  - handlers, a Telegram API client (plain `fetch` with `@grammyjs/types`
    for types);
  - conversation state;
  - `project.json` with esbuild targets.
- `shared`:
  - migration `0004` adds the bot tables, all with RLS:
    - `messenger_links`, `link_requests`;
    - `bot_conversations`, `bot_pending_uploads`, `bot_messages`;
  - domain functions for listing accounts and coverage reused by the bot.
- `ingestion`: the worker publishes outcomes to a new SQS queue.
- `infra/lib/`, new `bot.ts`:
  - API Gateway routes (`POST /telegram/webhook` with no Cognito authorizer,
    `GET /telegram/callback`);
  - an SQS FIFO update queue, the outcome queue, and an EventBridge Scheduler
    rule;
  - a Cognito app client for the callback;
  - Secrets Manager secrets for the bot token, webhook secret, and client
    secret;
  - IAM, including `cognito-idp:ListUsers` for email lookup.
- `eslint.config.mjs`: `scope:bot` boundary rule.
- One-time manual steps: create the bot with BotFather, store its token, and
  register the webhook (`bot:set-webhook` target).
- Docs: `docs/adr/0009-telegram-interface.md`, `docs/architecture.md`.
