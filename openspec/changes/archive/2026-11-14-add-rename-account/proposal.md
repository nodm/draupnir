## Why

An account's display name is typed once in `/newaccount` and can never be changed.
Typos and better names (e.g. "SEB main" → "Salary") force users to ask for a DB edit.

## What Changes

- New bot command `/renameaccount`: owner picks one of their accounts, sends a new
  name, name is saved.
- Rename is allowed for `owner` members only; viewers cannot.
- Name rules match `/newaccount`: non-empty after trim, up to 60 characters.
- Other linked members of the account are notified in Telegram (best-effort).
- No confirm step before saving.
- Name is per account (shared by all members), not per user.
- No schema change: the app role already has owner-scoped `UPDATE` on `accounts`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `telegram-account-commands`: add `/renameaccount` guided dialogue.
- `account-management`: add owner-only rename of an account's display name
  (account-management was create-only).

## Impact

- `bot`: new `commands/renameAccount.ts` (+ spec), wiring in `worker.ts` and the
  command list in `dispatcher.ts`, `docs/telegram-bot.md` command table + BotFather list.
- `shared`: new `renameAccount` in `accounts/` (+ spec), exported from the index.
- No migration, no infra change.
