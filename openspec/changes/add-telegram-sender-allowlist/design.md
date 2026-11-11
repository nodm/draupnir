## Context

See proposal.md - Why. `handleWebhook` (`bot/src/lib/webhook.ts`) is pure: it
takes `WebhookDeps` (`secret`, `enqueue`) and the Lambda entry
(`bot/src/webhook.ts`) wires them. It already acknowledges and drops
non-private chats with a 200. `bot-webhook` has no database access, and that
must stay.

## Goals / Non-Goals

**Goals:**
- Drop non-allowlisted senders before `enqueue`, with no database access.
- Fail closed on empty, missing or malformed config.

**Non-Goals:**
- Per-user rate limiting, worker changes (see proposal.md).

## Decisions

- **Allowlist in `WebhookDeps`** as `allowedUserIds: ReadonlySet<number>`.
  `handleWebhook` stays pure and unit-testable. Alternative: read
  `process.env` inside it; rejected, it breaks the existing deps pattern.
- **`parseAllowedUserIds(raw: string | undefined): Set<number>`** exported from
  `lib/webhook.ts`. Splits on commas, trims, skips empty segments (so a trailing
  comma is harmless), throws on any non-numeric entry (`/^\d+$/`, safe
  integer). Missing or empty input gives an empty set (fail closed).
- **Parse once per cold start** at module scope in `bot/src/webhook.ts`. A throw
  there fails Lambda init, so a bad config surfaces on the first invocation as
  a 502, not as silently ignored entries.
- **Sender** is `message.from?.id ?? callback_query.from.id`, via a
  `senderOfUpdate` helper next to `chatOfUpdate`. Callback queries always carry
  `from`; a message may lack it (channel posts), which is dropped.
- **Order of checks**: secret, parse/`update_id`, sender allowlist, private-chat
  check, enqueue. Sender check goes before the chat check so unknown senders
  are treated the same in every chat type.
- **Silent drop**: 200 with empty body, no `console.*` of the update. Telegram
  does not retry on 200.
- **Config**: `config.requireSecret('allowedTelegramUserIds')` in
  `infra/lib/bot.ts`, set as `ALLOWED_TELEGRAM_USER_IDS` on the `bot-webhook`
  function only. Secret so ids stay out of plain-text stack config. Env var,
  not Secrets Manager: no extra IAM or fetch latency, matching
  `ALLOWLISTED_EMAILS` in `infra/lib/cognito.ts`. `requireSecret` makes
  `pulumi up` fail if unset, which is the deploy-time guard.

## Risks / Trade-offs

- [Wrong or missing ids lock out the owners] → Fail closed is intended; docs
  explain how to get your id; rollback is `pulumi config set` + `infra:up`.
- [Env var visible in the Lambda console to anyone with Lambda read access] →
  Telegram user ids are not credentials; acceptable.
- [Changing the list needs a deploy] → Two fixed users; acceptable.
- [Unknown senders get no reply] → Intended; replying would need a Telegram
  call per update.

## Migration Plan

1. `pulumi config set --secret allowedTelegramUserIds "<id1>,<id2>"` in
   `infra/` (writes `Pulumi.prod.yaml`).
2. `pnpm exec nx run infra:preview`, then `infra:up`.
3. Check: message from an allowlisted account still answers.

Rollback: revert the commit and redeploy, or set the list to include the
missing id.
