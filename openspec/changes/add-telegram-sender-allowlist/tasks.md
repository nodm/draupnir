## 1. Webhook logic

- [x] 1.1 Add `senderOfUpdate` and `parseAllowedUserIds` to `bot/src/lib/webhook.ts`; unit tests cover valid list, whitespace, trailing comma, empty/undefined → empty set, non-numeric entry throws
- [x] 1.2 Add `allowedUserIds` to `WebhookDeps` and drop non-allowlisted or missing senders with 200 after the update_id check; tests in `bot/src/lib/webhook.spec.ts` cover allowed sender enqueued (message and callback_query), unknown sender, missing `from`, empty allowlist, secret check still first (401 for an allowlisted sender with a wrong secret); update existing specs' deps to include the allowlist
- [x] 1.3 Verify the drop path logs nothing (spy on `console` in a test)
- [x] 1.4 Parse `ALLOWED_TELEGRAM_USER_IDS` once at module scope in `bot/src/webhook.ts` and pass it in; verify `pnpm exec nx run bot:test` and `tsc --noEmit` pass

## 2. Infra

- [x] 2.1 Add `config.requireSecret('allowedTelegramUserIds')` as `ALLOWED_TELEGRAM_USER_IDS` on the `bot-webhook` environment only in `infra/lib/bot.ts`; verify `pnpm exec nx run infra:preview` (after 2.2) shows only that Lambda changing
- [x] 2.2 Set the secret config for prod (`pulumi config set --secret allowedTelegramUserIds ...` in `infra/`) with the user's two ids; verify `infra/Pulumi.prod.yaml` has an encrypted entry. Needs the ids from the user, ask first

## 3. Docs and spec

- [x] 3.1 Update `docs/telegram-bot.md`: how to find your Telegram user id, set the config before deploy (new step before "Deploy"), troubleshooting row for "bot never answers" when the id is missing; verify the steps read in order
- [x] 3.2 Run `pnpm exec openspec validate add-telegram-sender-allowlist` and verify it passes
- [x] 3.3 Lint/format and verify `pnpm exec nx affected -t lint test build` is green

## 4. Rollout

- [ ] 4.1 After deploy, send a message from an allowlisted account and verify a reply; check the webhook log group shows no update bodies
