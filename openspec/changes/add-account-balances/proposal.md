## Why

Questions about a user's current financial state are the most common ones put to
the MCP data tools, and Draupnir cannot answer them directly: an account has an
opening balance but no current balance, and only Revolut and monobank rows carry
a bank-reported balance (SEB rows have none). A client has to add up every
transaction itself. Keeping the balance in the database, updated in the same
transaction as each import, makes the answer exact, cheap to read, and checked
against the bank's own closing balance.

## What Changes

- Each account stores its current balance, the date it is as of, and whether it
  is reconciled (history continuous from the opening balance).
- Each transaction stores a running balance computed for every bank, separately
  from the bank-reported `balance_after_minor_units`, and an order key
  (`occurred_at`, `source_seq`) that makes the running balance well defined when
  several rows share a posted date.
- An import recomputes the account's balances inside its existing write
  transaction, under the account locks it already takes. Rebuilding an account
  recomputes them the same way.
- **BREAKING:** a gap between an import and the stored history is now a rejection
  with a message naming the missing range, not a warning. Statements must be
  imported in order, and the first one must connect to the account's opening
  balance and opening date. Importing out of chronological order is no longer
  accepted.
- An import is rejected, with nothing stored, when the computed balance after the
  file's last transaction differs from the bank's closing balance for formats
  that report one (Revolut, monobank). SEB has no closing balance in its export
  and is accepted unchecked; its continuity relies on declared periods.
- `list_accounts` returns the balance, the date it is as of, and the reconciled
  flag. `list_transactions` returns the running balance and orders by the new
  key. **BREAKING** (tool output): the bank-reported `balanceAfter` field is
  replaced by the running balance, and cursors from before the change are
  rejected as malformed.
- A migration adds the columns, and existing accounts are backfilled by rebuilding
  them. A follow-up tightens the new transaction columns to `NOT NULL` once prod
  is verified.
- Out of scope: parking a file until its predecessor arrives, a retry command
  for rejected files, and per-row comparison against the bank's `balance_after`.

## Capabilities

### New Capabilities
- `account-balances`: what balance an account and each transaction carry, when it
  is recomputed and under which lock, the check against the bank's closing
  balance, the transaction order key, and the backfill of existing accounts.

### Modified Capabilities
- `statement-validation`: a gap against stored history becomes a rejection, and
  the first file must connect to the account's opening.
- `statement-ingestion-pipeline`: acceptance of a file now depends on the order
  files are processed in, while data integrity still does not.
- `data-tools`: `list_accounts` returns the balance fields; `list_transactions`
  returns the running balance and orders by the new key.

## Impact

- `shared`: migrations `0018` (columns) and a later one for `NOT NULL`; the
  balance recompute used by import and rebuild; the two data tools.
- `ingestion`: `processStatementFile` turns the `gap-*` warnings into rejection
  reasons, recomputes balances and checks the closing balance in the write
  transaction; `rebuildAccount` recomputes; parsers emit `occurredAt` and
  `sourceSeq`.
- No new infrastructure. Every Lambda rebuilds because `shared` changes, and the
  migrate-database invocation reruns.
- Prod has real data: the migration is additive, accounts are backfilled by the
  existing rebuild, and nothing is deleted. The owner states existing accounts
  have no gaps; this is verified with `get_account_coverage` before relying on
  it.
- Adds ADR-0013 (stored balances, gap as error).
- Runs before `add-bot-ai-chat`, whose tools read the same balances.
