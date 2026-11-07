## Context

See proposal.md for why. Current state that shapes the approach:

- An import already runs in one Data API transaction that first locks every
  account it touches (`SELECT … FROM accounts … ORDER BY id FOR UPDATE`, with
  `lock_timeout` 30 s). `rebuildAccount` takes the same lock. Concurrency and
  deadlock ordering therefore exist; this change only adds work inside them.
- `accounts` has `opened_on` and `opening_balance_minor_units`. `transactions`
  has `amount_minor_units`, `fee_minor_units`, and a nullable
  `balance_after_minor_units` (the bank's figure: Revolut and monobank only). The
  balance chain already verifies `previous + amount − fee = balance_after` inside
  a file, so the fee is separate from the amount.
- Transactions have only `posted_date`. The parsers parse the full timestamp for
  Revolut (`Started Date`, `Completed Date`) and monobank (`Date and time`) but
  keep only the date, using noon UTC as a placeholder. SEB exports carry a date
  only and no balances. A Revolut row can start on one day and complete on the
  next; the balance changes on completion.
- Continuity is already computed (`computeCoverage`, `continuityWarnings`) and
  recorded as warnings on `statement_file_accounts`.
- `rebuildAccount` deletes and re-inserts an account's transactions, so ids
  change. It is not safe as a prod backfill that must keep rows.
- `list_transactions` pages by `(posted_date, id)` and returns the bank's
  balance-after; `list_accounts` returns no balance.
- Prod holds real data from two banks. The owner states existing accounts have
  no gaps.

## Goals / Non-Goals

**Goals:**
- A stored, bank-checked balance per account and a running balance per
  transaction, always consistent with the stored transactions.
- A transaction order that is deterministic and reproducible from raw rows.
- A backfill that keeps existing rows and their ids.

**Non-Goals:**
- Parking a file until its predecessor arrives, a retry command, or sorting a
  batch (the owner chose a plain rejection with a precise message).
- Comparing every row's running balance with the bank's `balance_after`.
- Changing `summarize_transactions` (it groups by posted date and is not
  affected).
- Multi-currency accounts (an account has one currency).

## Decisions

### 1. Recompute the whole account inside the existing lock

After an import writes its rows (and after a rebuild), one statement recomputes
every transaction's running balance for each account involved:

```sql
UPDATE transactions t
   SET running_balance_minor_units = r.balance
  FROM (SELECT id,
               CAST(:opening AS bigint)
                 + SUM(amount_minor_units - fee_minor_units)
                     OVER (ORDER BY occurred_at, source_seq, id) AS balance
          FROM transactions WHERE account_id = :accountId) r
 WHERE t.id = r.id AND t.account_id = :accountId
```

then the account row takes the last balance (or the opening balance when there
are no transactions) and the as-of date. It is always a recompute, never an
increment, so a retried or duplicate import cannot drift it.

- **Why the whole account, not from the insertion point:** with gaps rejected,
  new imports append after history, so a partial recompute would rarely differ,
  and the whole-account form is one simple, idempotent statement that also serves
  rebuild and the backfill. A personal account holds thousands of rows, so the
  cost is milliseconds. Revisit if an account reaches the order of 100k rows.
- **No new locking:** the account is already locked `FOR UPDATE`; several accounts
  are locked in id order. This satisfies the "single, blocking transaction"
  requirement.
- **Alternative, compute on read** (a window over the account in each query): never
  stale, but it puts the work on every question and the model cannot filter or
  sort by balance. Rejected by the owner in favor of stored values.
- No backslashes in any SQL literal: the Data API's parameter parser breaks on
  them.

### 2. Order key: `occurred_at` and `source_seq`

`transactions` gains `occurred_at timestamptz` and `source_seq integer`; the
order is `(occurred_at, source_seq, id)`.

| Bank | `occurred_at` | `source_seq` |
|---|---|---|
| Revolut | `Completed Date` (balance changes on completion) | rank in the file's chain order (sort by `Completed Date`, ties keep file order) |
| monobank | `Date and time` | reverse of file order (the export is newest first) |
| SEB | `DATA` at midnight | file order (not verified as chronological; see Risks) |

- The normalizers are the single place that knows this (they are what import and
  rebuild both use), so the order is reproducible from raw rows. `NormalizedRow`
  gains `occurredAt` and `sourceSeq`, and the chain-order code in
  `balanceChain.ts` and the new key share one function.
- The exports state no timezone. Timestamps are stored as given, read as UTC.
  Only ordering within one account matters, and one account has one bank.
- When a row appears in several files (overlap), the first stored row keeps its
  key (`ON CONFLICT DO NOTHING`); rebuild processes files oldest import first,
  so the result is the same.
- **Alternatives:** an integer `txn_order` per account renumbers later rows on a
  backfill; ordering by `(posted_date, import_seq, row_number)` needs joins and
  breaks when files overlap. The timestamp is also meaningful to users.
- A new index on `(account_id, occurred_at, source_seq, id)` serves the keyset
  pagination.

### 3. `balance_as_of` is the day the balance last changed

The as-of date is the date part of the latest transaction's `occurred_at`, not
its `posted_date`: a Revolut row posted on 28 August that completed on 29
August changes the balance on the 29th. With no transactions it is `opened_on`.

### 4. Reconciled flag from coverage

`balance_reconciled` is true only when the account's coverage has no `gap` or
`unknown` link and connects to the opening (`computeCoverage` over the stored
segments). It is recomputed at the same moments as the balance. With gaps
rejected it stays true for every account imported after this change; it can be
false for legacy data, and the flag is what the tools hand to the model.

### 5. Gap becomes a rejection

`continuityWarnings` returns hard reasons instead of warnings for `gap-before`,
`gap-after` and `gap-opening`; they join the `reasons` list that already rejects a
file in the same transaction, before any row is written. The messages name the
range: where stored history ends and where the file starts (or the reverse), or
the account's opening date and balance for a first file. Unknown continuity is not
a reason. `statement_file_accounts.warnings` stays for any remaining warnings, and
old warnings stay on old rows.

The rejection reuses the existing path, so redelivery and idempotency are
unchanged. The user sees the reason through the bot's existing rejection message.

### 6. Closing-balance check, then rollback and record

For a format with a closing balance (balances already computed in validation), the
check runs after the recompute: the running balance of the file's last
transaction (greatest `(occurred_at, source_seq, id)` among rows sourced from this
file) must equal the file's closing balance. A mismatch throws a typed error from
the transaction callback, which rolls back every write and balance, and the file
is then recorded as rejected through `recordRejection`, which already writes a
rejection in its own transaction. Only the final row is compared: ties in
`occurred_at` inside a file cannot change the balance after its last row, whereas
a per-row comparison could reject good files on an unresolvable tie.

- **Alternative, check arithmetically before writing:** overlaps and dedup make
  the expected balance depend on which rows are new, so computing it in SQL after
  the write is simpler and exact.

### 7. Data tools

- `list_accounts` adds `balanceMinorUnits`, `balanceAsOf`, `balanceReconciled`, and
  its description tells the model to state the as-of date and to say when a
  balance is not reconciled.
- `list_transactions` replaces the bank's balance-after in its output with
  `runningBalanceMinorUnits` (one balance per row avoids two similar fields
  confusing a model; the bank's value stays in the table). It orders and pages by
  `(occurred_at, source_seq, id)`: the keyset predicate becomes
  `(t.occurred_at, t.source_seq, t.id) < (:cursorAt, :cursorSeq, :cursorId)`, and the
  cursor encodes those. Old cursors fail to decode and are rejected as malformed.
  The `from` and `to` filters stay on `posted_date`.
- The MCP adapter exposes the shared tools unchanged, so `mcp-data-tools` needs no
  requirement change.

### 8. Migration, expand then contract, without deleting rows

1. `0018` adds the new columns as nullable (`accounts.balance_minor_units`,
   `balance_as_of`, `balance_reconciled`; `transactions.occurred_at`,
   `source_seq`, `running_balance_minor_units`) and the index. Nothing is
   removed. New imports and rebuilds fill them from the moment of deploy.
2. A backfill pass, run once per account after deploy, loads the account's raw
   rows, normalizes them in memory, and `UPDATE`s the existing transactions by
   `dedup_key` to set `occurred_at` and `source_seq`, then recomputes balances
   under the account lock. Ids are kept; `rebuildAccount` is not used because it
   deletes and re-inserts.
3. Before step 2, check each prod account with `get_account_coverage` (no gap,
   connects to the opening). After it, check that no new column is `NULL` and
   that each Revolut and monobank account's balance equals its latest statement's
   closing balance.
4. A follow-up change (own PR) adds migration `0019`: `NOT NULL` on the new
   columns. It is separate because `migrate-database` runs on every deploy, and the
   constraint must wait for the verified backfill.

Rollback: the columns are additive, so redeploying the previous code works; rows
written meanwhile have `NULL`s and are fixed by running the backfill again.

## Risks / Trade-offs

- **SEB same-day order is unverified** → file order is assumed chronological;
  confirm against a real export. If wrong, SEB's end-of-day balance is still exact
  and only the within-day running balances are affected; the spec states the weaker
  guarantee.
- **Equal timestamps** (Revolut `Completed Date` ties) → ordered by file position,
  then id; the closing check compares only the last row, so a tie cannot reject a
  good file.
- **Files uploaded together are processed in any order** → a later file can be
  rejected before its predecessor lands (owner's chosen option 1). The message names
  the missing period; parking or a retry command is a later change.
- **Row-level security on the new writes** → imports run as the uploader, who must
  be an owner; confirm the `UPDATE` on `accounts` and `transactions` is allowed for
  owners under the existing policies and add one if not (a task).
- **Statement time on large accounts** → a whole-account window update; measured on
  prod volumes before relying on it, and the Data API per-statement time limit is
  well above it for thousands of rows.
- **Breaking tool output** → `balanceAfter` disappears from `list_transactions` and
  old cursors are rejected; the only consumer is the MCP clients and the cursor
  lifetime is one pagination session.
- **Time zone** → timestamps are read as UTC; only same-account ordering and the
  as-of date use them, so a constant offset changes nothing visible except possibly
  the as-of date around midnight.

## Open Questions

- None that change the specs or tasks. The SEB export order and the exact Revolut
  and monobank timestamp formats are verified while implementing (task 2.1); the
  design holds either way.
