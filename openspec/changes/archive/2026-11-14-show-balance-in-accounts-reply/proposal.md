## Why

Accounts now store a bank-checked current balance (`account-balances`), but `/accounts` in the bot does not show it. The first thing a user asks about an account is "how much is on it".

## What Changes

- `/accounts` shows each account's current balance, formatted in the account's currency, with the date it is as of.
- An unreconciled balance is marked as such, so it is not read as bank-confirmed.
- `/coverage` is unchanged.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `telegram-account-commands`: the "Users can list their accounts" requirement gains a balance line per account.

## Impact

- `bot/src/lib/memberAccounts.ts`: select `balance_minor_units`, `balance_as_of`, `balance_reconciled`.
- `bot/src/lib/accounts/format.ts`: balance line in `formatAccountList` (uses `shared` money helpers).
- `bot/src/lib/commands/accounts.ts`: no behavior change expected.
- `docs/telegram-bot.md`: `/accounts` row.
- No schema change, no new dependency.
