# ADR-0013: Stored Account Balances, Running Balances and Gaps as Rejections

## Status

Accepted

## Date

2026-11-07

## Deciders

Dmytro Novikov

## Context

Questions about a user's current state ("how much do I have?") are the most common ones put to the
MCP data tools ([ADR-0010](./0010-mcp-data-tools.md)), but an account held only an opening balance.
Only Revolut and monobank rows carry a bank-reported balance; SEB rows have none, so a client had
to add up every transaction itself. Continuity between statements was only a warning
([ADR-0008](./0008-statement-data-model.md)), so a stored balance could silently be wrong.

## Decision

- **Stored balance.** `accounts` keeps `balance_minor_units` (opening balance plus the sum of every
  transaction's amount minus fee), `balance_as_of` (the day the balance last changed, `opened_on`
  when never) and `balance_reconciled` (history continuous from the opening balance).
- **Running balance.** Every transaction keeps `running_balance_minor_units`, computed for every
  bank and stored apart from the bank's own `balance_after_minor_units`, which is unchanged.
- **Order key.** Transactions are ordered by `(occurred_at, source_seq, id)`. `occurred_at` is when
  the balance changed (Revolut: completion time; monobank: its timestamp; SEB: the date at
  midnight), read as UTC because the exports state no zone. `source_seq` is the row's place in its
  file's chronological order. The normalizers produce both (`parsers/order.ts`), so import, rebuild
  and the backfill agree and the order is reproducible from raw rows.
- **Recompute, never increment.** Imports and rebuilds recompute the whole account in the
  transaction that stores the rows, under the `FOR UPDATE` account lock they already take (locks in
  id order). A retried or duplicate import cannot drift the balance.
- **A gap is a rejection.** A file that does not connect to stored history, or a first file that
  does not connect to the account's opening balance and date, is rejected with a message naming the
  missing period. Statements must be imported in order. Unknown continuity is still accepted.
- **Closing-balance check.** For Revolut and monobank the running balance after the file's last
  transaction must equal the file's closing balance, or the whole import rolls back and the file is
  recorded as rejected, naming both amounts. SEB has no closing balance and is accepted unchecked.
- **Data tools.** `list_accounts` returns the balance, its date and the reconciled flag.
  `list_transactions` returns `runningBalanceMinorUnits` instead of the bank's figure and pages by
  the order key; cursors from before the change are rejected as malformed.
- **Expand, then contract.** Migration `0018` adds the columns and an index and deletes nothing.
  The account balance columns are `NOT NULL` at once: existing accounts get their opening balance
  as of `opened_on` with `reconciled = false` (a placeholder that tools flag), and a trigger starts
  every new account at its opening balance, reconciled. The transaction columns stay nullable
  because the order key comes from raw rows. A backfill (the rebuild Lambda with
  `"mode":"backfill"`) fills them and corrects the account balances; it updates rows by
  `dedup_key` and never deletes or re-inserts, so ids survive. A later migration makes the
  transaction columns `NOT NULL` once prod is verified.

## Consequences

- Files uploaded together are processed in any order, so a later file can be rejected before its
  predecessor lands; the message says what to import first and the file can be uploaded again.
  Parking a file until its predecessor arrives and a retry command are separate, later changes.
- SEB limits: the file order is assumed chronological for same-day rows, so only the within-day
  running balances depend on it; the end-of-day balance is exact. SEB continuity relies on declared
  periods, not balances.
- A whole-account window update per import is milliseconds for thousands of rows; revisit near
  100k rows in one account.
- `list_transactions` loses `balanceAfter`. The bank's value stays in the table.
- Rolling back the code is safe: the columns are additive, and rows written meanwhile are fixed by
  running the backfill again.
