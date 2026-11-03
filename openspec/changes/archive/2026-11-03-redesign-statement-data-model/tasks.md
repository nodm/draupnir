## 1. Decision record

- [x] 1.1 Write `docs/adr/0008-statement-data-model.md` (ADR format): raw `jsonb` rows +
      derived common table + account membership + balance-check tiers. Alternatives with
      trade-offs: table per bank, separate document DB (DynamoDB/DocumentDB), single-owner +
      share grants, dedup at raw level. Verify it is linked like ADR-0001..0007.

## 2. Schema

- [x] 2.1 Add migration `0002-statement-data-model` to `shared`'s `MIGRATIONS`, dropping
      `share_grants`, `transactions`, `accounts` and creating the schema from design.md
      decision 1; verify pglite tests for every `transactions-schema` scenario plus: last
      `statement_files` partial unique index rejects a second `approved` row with the same
      `(upload_account_id, sha256)` but allows a `rejected` one; `s3_key` is unique;
      `raw_rows` `(file_id, row_number)` is unique; a `transaction_sources` row linking a
      transaction and a raw row of different accounts is rejected by the composite FKs; role
      CHECK rejects values other than `owner`/`viewer`.
- [x] 2.2 Remove `shared/src/lib/shareGrants.ts` and its exports; add
      `shared/src/lib/membership.ts` with `memberPredicate(alias, accountIdColumn, minRole)`
      (`'id'` for `accounts`, `'account_id'` for child tables; verify both generate valid SQL
      against pglite) and the
      add/remove/change-role domain functions enforcing owner-only changes and the last-owner
      rule under a row lock; verify pglite tests for every `row-level-authorization`
      scenario.

## 3. Parsers

- [x] 3.1 Change the parser output type (`ingestion/src/lib/parsers/types.ts`) to raw payload +
      row number + format version + bank transaction id + optional normalized row with
      `feeMinorUnits`/`balanceAfterMinorUnits`, plus file-level declared bounds; update the SEB
      parser (fee 0, no balance, declared period from the `UŽ LAIKOTARPĮ` title line);
      verify existing SEB fixture tests still pass and assert raw payload strings are
      unchanged (e.g. `"50,00"`).
- [x] 3.2 Update the Revolut parser: `Started Date` for `posted_date` and dedup, only
      `COMPLETED` rows normalized, `Product` ≠ `Current` raw-only, fee and balance extracted;
      verify fixture tests for each `bank-statement-parsers` Revolut scenario, including the
      pending-then-completed key stability case (add fixture rows as needed).
- [x] 3.3 Update the monobank parser: commission and balance extracted, raw payload kept
      (`—` preserved); verify fixture tests.

## 4. Validation

- [x] 4.1 Add `zod` and `ingestion/src/lib/validation/` with per-bank format-version
      definitions (header signature, row schema, balance-chain rules) and header checks
      (unknown format, duplicate header); verify tests for each format scenario in
      `statement-validation`, and that all row errors are collected with row numbers.
- [x] 4.2 Implement the balance-chain check (Revolut `COMPLETED` rows in `Completed Date` order,
      monobank newest-first reversed, SEB skipped); verify tests: consistent chain passes
      (fixture 11.62 → 11.33), broken chain reports row + expected/actual, skipped
      non-balance rows.
- [x] 4.3 Implement overlap agreement and the continuity/coverage computation from design.md
      decision 3a (segments from `statement_file_accounts`; continuity by balances, declared
      periods, or unknown; "reconciled up to"); verify pglite-backed tests for the
      overlap-accept, overlap-conflict, out-of-order-with-warning, connected-no-warning,
      days-without-activity, unknown-continuity, coverage-report, and non-selected-account
      coverage scenarios.

## 5. Ingestion pipeline

- [x] 5.1 Rewrite `processStatementFile.ts` per design.md decisions 3 and 3b: redelivery check by
      `s3_key` first; file-only validation; then one transaction that locks the resolved
      accounts in id order (`lock_timeout` 30s), runs the duplicate/overlap/continuity checks,
      and writes either the rejected `statement_files` row or the file, per-account records,
      raw rows, transactions (`ON CONFLICT (account_id, dedup_key)`), and sources, with
      byte-based chunking; map the partial-unique-index conflict to a duplicate rejection.
      Verify tests for every `statement-ingestion-pipeline`, `statement-raw-storage`, and
      `statement-validation` scenario (mocked Data API + pglite where the SQL matters),
      including validation-failure-not-retried, concurrent duplicate upload, concurrent
      conflicting SEB files (one approved, one rejected), and redelivery after commit.
- [x] 5.2 Implement `deriveTransactions` as a pure function and a `rebuildAccount` maintenance
      handler (new esbuild target and Lambda in `infra`, invoked manually); verify tests:
      rebuild reproduces the original rows; rebuild after a normalization change updates
      descriptions without re-upload.

## 6. Accounts and upload

- [x] 6.1 Update `ingestion/src/lib/accounts.ts`: create account + owner membership in one
      transaction, opening date and balance required, duplicate-IBAN reason tells the caller
      to ask an owner to add them; verify every `account-management` scenario.
- [x] 6.2 Update `presignedUpload.ts` to require `owner` membership; verify every
      `statement-csv-upload` scenario, including viewer rejected.

## 7. Deploy and verify

- [x] 7.1 Ask the user to confirm the live `accounts`/`transactions`/`share_grants` rows are
      disposable (or export them first); then `pnpm exec nx run infra:up` and verify
      `schema_migrations` records `0002` and the new tables exist.
- [x] 7.2 Live E2E: create an account with opening balance via `POST /accounts`, upload the
      Revolut and monobank fixtures via presigned URLs, and verify the files are `approved`,
      raw rows include the Revolut `PENDING` row, transactions exclude it, and re-uploading the
      same file is recorded as a duplicate rejection.
- [x] 7.3 Verify `pnpm exec nx run-many -t lint test build` passes and update
      `docs/architecture.md` with the three-layer storage model.
