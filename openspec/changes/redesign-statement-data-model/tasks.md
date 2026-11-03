## 1. Decision record

- [ ] 1.1 Write `docs/adr/0008-statement-data-model.md` (ADR format): raw `jsonb` rows +
      derived common table + account membership + balance-check tiers. Alternatives with
      trade-offs: table per bank, separate document DB (DynamoDB/DocumentDB), single-owner +
      share grants, dedup at raw level. Verify it is linked like ADR-0001..0007.

## 2. Schema

- [ ] 2.1 Add migration `0002-statement-data-model` to `shared`'s `MIGRATIONS`, dropping
      `share_grants`, `transactions`, `accounts` and creating the schema from design.md
      decision 1; verify pglite tests for every `transactions-schema` scenario plus: last
      `statement_files` partial unique index rejects a second `approved` row with the same
      `(account_id, sha256)` but allows a `rejected` one; `raw_rows` `(file_id, row_number)`
      is unique; role CHECK rejects values other than `owner`/`viewer`.
- [ ] 2.2 Remove `shared/src/lib/shareGrants.ts` and its exports; add
      `shared/src/lib/membership.ts` with `memberPredicate(alias, minRole)` and the
      add/remove/change-role domain functions enforcing owner-only changes and the last-owner
      rule under a row lock; verify pglite tests for every `row-level-authorization`
      scenario.

## 3. Parsers

- [ ] 3.1 Change the parser output type (`ingestion/src/lib/parsers/types.ts`) to raw payload +
      row number + format version + bank transaction id + optional normalized row with
      `feeMinorUnits`/`balanceAfterMinorUnits`; update the SEB parser (fee 0, no balance);
      verify existing SEB fixture tests still pass and assert raw payload strings are
      unchanged (e.g. `"50,00"`).
- [ ] 3.2 Update the Revolut parser: `Started Date` for `posted_date` and dedup, only
      `COMPLETED` rows normalized, `Product` ≠ `Current` raw-only, fee and balance extracted;
      verify fixture tests for each `bank-statement-parsers` Revolut scenario, including the
      pending-then-completed key stability case (add fixture rows as needed).
- [ ] 3.3 Update the monobank parser: commission and balance extracted, raw payload kept
      (`—` preserved); verify fixture tests.

## 4. Validation

- [ ] 4.1 Add `zod` and `ingestion/src/lib/validation/` with per-bank format-version
      definitions (header signature, row schema, balance-chain rules) and header checks
      (unknown format, duplicate header); verify tests for each format scenario in
      `statement-validation`, and that all row errors are collected with row numbers.
- [ ] 4.2 Implement the balance-chain check (Revolut `COMPLETED` rows in `Completed Date` order,
      monobank newest-first reversed, SEB skipped); verify tests: consistent chain passes
      (fixture 11.62 → 11.33), broken chain reports row + expected/actual, skipped
      non-balance rows.
- [ ] 4.3 Implement overlap agreement and continuity/coverage computation (expected opening
      balance from latest stored balance-after or account opening balance; gap warnings;
      coverage periods and "reconciled up to"); verify pglite-backed tests for the
      overlap-accept, overlap-conflict, out-of-order-with-warning, connected-no-warning, and
      coverage-report scenarios.

## 5. Ingestion pipeline

- [ ] 5.1 Rewrite `processStatementFile.ts`: validate → on rejection write only the
      `statement_files` row and acknowledge the message → on approval write file, raw rows,
      transactions (`ON CONFLICT (account_id, dedup_key)`), and sources in one transaction
      with byte-based chunking; map the partial-unique-index conflict to a duplicate
      rejection; verify tests for every `statement-ingestion-pipeline` and
      `statement-raw-storage` scenario (mocked Data API + pglite where the SQL matters),
      including validation-failure-not-retried and concurrent duplicate upload.
- [ ] 5.2 Implement `deriveTransactions` as a pure function and a `rebuildAccount` maintenance
      handler (new esbuild target and Lambda in `infra`, invoked manually); verify tests:
      rebuild reproduces the original rows; rebuild after a normalization change updates
      descriptions without re-upload.

## 6. Accounts and upload

- [ ] 6.1 Update `ingestion/src/lib/accounts.ts`: create account + owner membership in one
      transaction, opening date and balance required, duplicate-IBAN reason tells the caller
      to ask an owner to add them; verify every `account-management` scenario.
- [ ] 6.2 Update `presignedUpload.ts` to require `owner` membership; verify every
      `statement-csv-upload` scenario, including viewer rejected.

## 7. Deploy and verify

- [ ] 7.1 Ask the user to confirm the live `accounts`/`transactions`/`share_grants` rows are
      disposable (or export them first); then `pnpm exec nx run infra:up` and verify
      `schema_migrations` records `0002` and the new tables exist.
- [ ] 7.2 Live E2E: create an account with opening balance via `POST /accounts`, upload the
      Revolut and monobank fixtures via presigned URLs, and verify the files are `approved`,
      raw rows include the Revolut `PENDING` row, transactions exclude it, and re-uploading the
      same file is recorded as a duplicate rejection.
- [ ] 7.3 Verify `pnpm exec nx run-many -t lint test build` passes and update
      `docs/architecture.md` with the three-layer storage model.
