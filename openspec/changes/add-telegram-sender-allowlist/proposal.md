## Why

The bot has two intended users, but the webhook accepts updates from any Telegram user. Every accepted update is queued and the worker then makes Data API calls (`resolveSub`, plus `createRequest` for unlinked users), and each call resumes the paused Aurora cluster. A sender allowlist at the webhook is an access and cost guardrail: updates from anyone else are dropped before they are queued, so they never reach the worker or the database.

## What Changes

- New Pulumi secret config `draupnir-infra:allowedTelegramUserIds`: comma-separated numeric Telegram user ids.
- `infra/lib/bot.ts` passes it to the `bot-webhook` Lambda only, as an environment variable.
- `handleWebhook` takes the sender id from `message.from.id` or `callback_query.from.id`, after the secret-header check and `update_id` validation. A missing sender or one not on the allowlist gets a 200 response, is not queued and its body is not logged.
- Fail closed: an empty or missing allowlist drops every update. The list is parsed once per cold start; a non-numeric entry fails startup.
- Linking (`/start`, the 6-digit code) is unchanged for allowlisted users who are not yet linked.
- The webhook still never touches the database.
- Docs: `docs/telegram-bot.md` explains how to find your Telegram user id and set the config.

Non-goals: per-user rate limiting, changes to the worker.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `telegram-bot-webhook`: adds a requirement that only updates from allowlisted Telegram users are queued, and that the allowlist fails closed.

## Impact

- `bot/src/lib/webhook.ts`, `bot/src/webhook.ts`, `bot/src/lib/webhook.spec.ts`
- `infra/lib/bot.ts`, `infra/Pulumi.prod.yaml` (new encrypted config value, set before deploy)
- `docs/telegram-bot.md`
- `openspec/specs/telegram-bot-webhook` (delta)
- Deploy order: set the config before `infra:up`. Without it the webhook Lambda fails at startup (fail closed) and the bot stops answering.
