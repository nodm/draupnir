## 1. Schema

- [x] 1.1 Add migration `0018` with nullable `accounts.balance_minor_units`, `balance_as_of`,
      `balance_reconciled` and `transactions.occurred_at`, `source_seq`,
      `running_balance_minor_units`, plus an index on `(account_id, occurred_at, source_seq, dedup_key, id)`;
      nothing is dropped. Verify the migration spec applies it on PGlite and the index exists.
- [x] 1.2 Check that an account owner can `UPDATE` the new `accounts` and `transactions` columns
      under the existing row-level policies as `draupnir_app`, and add a policy migration if not;
      verify with a PGlite test as an owner (allowed) and as a viewer (denied).

## 2. Order key

- [x] 2.1 Confirm the Revolut and monobank timestamp formats from the fixtures and whether an SEB
      export lists rows oldest first (a real export, not only the fixture); verify by recording
      the findings in `design.md` Risks and adding fixtures covering same-day rows.
- [x] 2.2 Add `occurredAt` and `sourceSeq` to `NormalizedRow` and to the Revolut (completion time),
      monobank (reverse of file order) and SEB (date at midnight, file order) normalizers,
      sharing one chain-order function with `balanceChain.ts`; verify with parser tests for
      same-day ties, monobank's newest-first export, and a Revolut row completed the day after
      it started.
- [x] 2.3 Store the keys when transactions are written (`statementWrites`) and keep the first
      row's keys on a deduplicated row; verify with a test where two overlapping files share a
      row and with a rebuild test that reproduces identical keys.

## 3. Recomputing balances

- [x] 3.1 Add a shared function that recomputes one account's running balances, balance, as-of
      date (date of the latest `occurred_at`, else `opened_on`) and reconciled flag (coverage
      continuous and connected to the opening); verify with PGlite tests for no transactions,
      fees, same-day order, idempotent repeat, and a gap giving `false`.
- [x] 3.2 Set a new account's balance to its opening balance, as of its opening date and
      reconciled, in account creation; verify with the account creation test.
- [x] 3.3 Call the recompute inside the import transaction after the rows are written, and in
      `rebuildAccount`, for every account touched; verify that two concurrent imports into one
      account leave balance equal to opening plus the sum of the transactions, and that a write
      failure after the recompute leaves the old balances.

## 4. Rejections

- [x] 4.1 Turn the `gap-before`, `gap-after` and `gap-opening` warnings into rejection reasons
      that name the missing period (history end and file start, or the reverse, or the account's
      opening date and balance for a first file); unknown continuity stays accepted; verify with
      the coverage validation tests and a file-processing test that stores nothing on rejection.
- [x] 4.2 After the recompute, compare the running balance of the file's last transaction with
      its closing balance for Revolut and monobank; on mismatch roll back and record the file as
      rejected naming both amounts through the existing rejection path; verify with a mismatch
      test storing nothing, a matching test approving, and an SEB test approving unchecked.
- [x] 4.3 Update tests that assumed out-of-order files are accepted, and add one for the
      pipeline scenario: a file processed before its predecessor is rejected, then accepted when
      uploaded again after the predecessor; verify the ingestion suite passes.

## 5. Data tools

- [x] 5.1 Add the balance, as-of date and reconciled flag to `list_accounts`, with the description
      telling the model to state the date and flag unreconciled balances; verify with owner and
      viewer tests.
- [x] 5.2 Return the running balance (`runningBalanceMinorUnits`) in `list_transactions` instead
      of the bank's balance-after, and order and page by `(occurred_at, source_seq, dedup_key, id)`;
      verify pagination over same-day rows has no gaps or duplicates, a pre-change cursor is
      rejected as malformed, and each row's balance equals the next-older row's plus its amount
      minus its fee.
- [x] 5.3 Update the MCP end-to-end test over PGlite for the new fields and confirm the adapter
      needs no code change; verify `nx test mcp` passes.

## 6. Backfill and rollout

- [x] 6.1 Write the backfill: for an account, load its raw rows, normalize in memory, `UPDATE`
      existing transactions by `dedup_key` with `occurred_at` and `source_seq` (no delete or
      insert), then recompute under the account lock; expose it as a one-off invocation of the
      rebuild Lambda; verify on PGlite that ids are unchanged, keys and balances are set, and a
      second run changes nothing.
- [x] 6.2 Write `docs/adr/0013-stored-account-balances.md` (stored balance and running balance,
      order key, gap as rejection, closing-balance check, SEB limits, expand then contract
      migration) and verify its links resolve.
- [x] 6.3 Before deploying, run `get_account_coverage` for every prod account and record that
      none has a gap and each connects to its opening; stop and ask if any does not.
      Result 2026-11-07: 12 accounts, no gaps. 10 connect to the opening (continuous). 2 SEB
      savings deposits (`****1886`, `****2927`) have no imported statements, so connectsToOpening
      is `unknown`; they stay reconciled with balance = opening. Owner confirmed: leave them as is.
- [x] 6.4 Deploy from `main` (the owner runs `infra:up`), run the backfill for each prod account,
      then verify no new column is `NULL`, each Revolut and monobank account's balance equals its
      latest statement's closing balance, and `list_accounts` over MCP shows the balances; record
      the results in this file.
      Results 2026-11-07: deployed #61 (migration `0018` applied), then backfilled all 12
      accounts with `{"mode":"backfill"}`; each reports `withoutOrderKey: 0` and
      `reconciled: true`. Balances (EUR, minor units): Revolut 14233 as of 2026-10-30
      (588 transactions); SEB main 109955 as of 2026-10-31 (4232); 8 other SEB accounts
      between 1 and 265 transactions; 2 empty SEB deposits 0 at their opening date. The
      newest running balance equals the stored balance on the three accounts spot-checked
      over MCP (Revolut, SEB main, SEB rental), and `list_accounts` and `list_transactions`
      show the new fields. The owner confirmed the Revolut balance (14233) is right against
      the bank.
      Two fixes were needed on the way: #62 (raw rows read in pages, the Data API caps a
      result at 1 MB) and #63 (rebuild-account Lambda 1024 MB and 900 s; 128 MB ran out on
      SEB main). Follow-up issue for `0019`: #64.
- [x] 6.5 Open an issue for the follow-up migration `0019` (`NOT NULL` on the new `transactions` columns; the `accounts` ones are `NOT NULL` in `0018`) to
      ship after 6.4 is verified, and verify the issue exists.
- [x] 6.6 Verify `pnpm exec nx run-many -t lint test build -p shared ingestion mcp bot infra`
      passes.
