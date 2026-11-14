## 1. Shared

- [x] 1.1 Add `MAX_DISPLAY_NAME_LENGTH = 60`; use it in `newAccount.ts`
- [x] 1.2 Add `renameAccount(client, config, sub, { accountId, displayName })` in `shared/src/lib/accounts/`, validate name, owner-only via RLS (0 rows ⇒ `NotAccountOwnerError`); export from index
- [x] 1.3 Tests: owner renames, non-owner rejected, invalid names rejected

## 2. Bot

- [x] 2.0 Extract `notify`/`whoIs` from `share.ts` into a shared bot helper (no behavior change, `share.spec.ts` stays green)
- [x] 2.1 `bot/src/lib/commands/renameAccount.ts`: handler, text step, callback (nonce, expiry, `/cancel`), skip pick when one owned account, notify other linked members best-effort
- [x] 2.2 Wire in `worker.ts` (command `renameaccount`, callback prefix `ra`, free-text routing) and add to command list in `dispatcher.ts`
- [x] 2.3 Tests: scenarios from the spec (multi/single account, invalid name, viewer-only, ownership lost, expired buttons, member notified, unlinked/failed notify)

## 3. Docs

- [x] 3.1 `docs/telegram-bot.md`: command table + BotFather command list
- [x] 3.2 Run `pnpm nx run-many -t lint test typecheck`; `openspec validate add-rename-account`
