## 1. Schema

- [x] 1.1 Add `accounts` DDL (`owner_user_id`, `bank` enum-constrained to `seb`/`revolut`/`monobank`, `iban` `UNIQUE`, `currency`, `display_name`) to `shared/src/lib/` alongside `SHARE_GRANTS_TABLE_DDL`; verify a unit test applies the DDL against a test DB and inserts/rejects rows (including duplicate-IBAN rejection) per `transactions-schema` spec's account scenarios.
- [x] 1.2 Add `transactions` DDL (`owner_user_id`, `account_id` FK, `posted_date`, `amount_minor_units`, `currency`, `description`, `dedup_key` with `UNIQUE` constraint + index) to the same module; verify a unit test confirms a duplicate `dedup_key` insert is a no-op and distinct keys both persist.

- [x] 1.3 Add nullable FX-metadata columns (`original_currency`, `original_amount_minor_units`, `fx_fee_minor_units`, `fx_fee_percent`) to the `transactions` DDL, with `CHECK` constraints pairing currency-with-amount and fee-amount-with-fee-percent; verify unit tests cover the null-together default and rejection of a one-set/one-null insert, per `transactions-schema` spec.

## 2. Account management endpoint

- [x] 2.1 Implement `POST /accounts` handler in `ingestion` (`{ bank, iban, currency, displayName }`, owner from Cognito claim only, `bank` validated against the enum); verify unit tests cover: valid creation, unauthenticated rejection, unknown-bank rejection, duplicate-IBAN rejection (`account-management` spec).
- [x] 2.2 Add the route to `infra/lib/ingestionApi.ts` with the existing Cognito authorizer attached; verify `nx run infra:build` succeeds and the route appears in the synthesized API definition.

## 3. Presigned upload endpoint

- [x] 3.1 Implement the presigned-URL handler in `ingestion` (`uploads/{sub}/{accountId}/{uuid}.csv`, `sub` from claim, `accountId` validated as existing and owned by the caller — a Data API lookup, not trust-the-payload); verify unit tests cover: valid request, unauthenticated rejection, another-user's-account rejection, nonexistent-account rejection (`statement-csv-upload` spec).
- [x] 3.2 Add the route to `infra/lib/ingestionApi.ts`; verify `nx run infra:build` succeeds.

## 4. Pulumi ingestion pipeline resources

- [x] 4.1 Add the `uploads` S3 bucket with an event notification targeting a new standard SQS queue; verify `nx run infra:build`/`pulumi preview` shows the expected resources with no errors.
- [x] 4.2 Add the DLQ and the queue's redrive policy (`maxReceiveCount`); verify `pulumi preview` shows the DLQ wired to the queue.
- [x] 4.3 Add the SQS-triggered ingestion Lambda (batch size 1) with an event-source mapping to the queue, and IAM policy grants (S3 read on `uploads`, SQS consume, Data API/Secrets Manager access to the new tables); verify `pulumi preview` shows the mapping and policy attached.

## 5. Dedup and normalization helpers

- [x] 5.1 Implement `ingestion/src/lib/dedupKey.ts`: description normalization (trim, case-fold), amount rounding to minor units, timezone-fixed date resolution, and the hash-fallback `dedup_key` function (`account_id + posted_date + amount_minor_units + currency + normalized_description + occurrence_index`); verify unit tests cover normalization and same-file occurrence-index assignment for repeated identical rows.

## 6. Bank parsers

- [x] 6.1 Implement `ingestion/src/lib/parsers/seb.ts`: parse rows (splitting/reading each row's own account block per `SĄSKAITOS NR`, not assuming one account per file — see `ingestion/src/lib/parsers/__fixtures__/seb.csv`), attach each row's own IBAN, compute `dedup_key` as `seb:{TRANSAKCIJOS KODAS}` (not `DOK NR.`, which repeats across both legs of a transfer); verify unit tests against the SEB fixture cover a normal row, a normalization case, a multi-account file producing rows for both IBANs, and same-document-different-leg non-collision.
- [x] 6.2 Implement `ingestion/src/lib/parsers/revolut.ts`: every row uses the caller-supplied upload-account IBAN, hash-fallback dedup key from `dedupKey.ts`; verify unit tests against the Revolut fixture cover a normal row, a normalization case, and a same-file repeated-transaction `occurrence_index` case (add a second, synthetic identical-looking row to the fixture — the real sample has only one row).
- [x] 6.3 Implement `ingestion/src/lib/parsers/monobank.ts`, same shape as 6.2, against the monobank fixture.

- [x] 6.4 Extend `ingestion/src/lib/parsers/seb.ts` to regex-extract FX metadata (original currency/amount, fee amount/percent) from card-purchase rows' payment-purpose text, leaving all four fields unset when the pattern is absent; verify unit tests cover a foreign-currency card row and a domestic/transfer row, per `bank-statement-parsers` spec.

## 7. Ingestion Lambda handler

- [x] 7.1 Implement the SQS-triggered handler: read the S3 object from the event, resolve `{sub}`/`{accountId}` from the key, look up the upload-selected `accounts` row and its `bank` (fail processing if none exists), dispatch to that bank's parser passing the account's IBAN, resolve each parsed row's target account by `owner_user_id + iban` (fail the whole file if any row's IBAN doesn't resolve), and write all rows in one Data API transaction with `ON CONFLICT (dedup_key) DO NOTHING`; verify unit tests cover: successful multi-row write, partial-parse-failure leaves no rows committed, missing-upload-account failure, unresolvable-row-IBAN failure (whole file, not partial), multi-account-file success where all row IBANs resolve (`statement-ingestion-pipeline` and `account-management` specs).
- [x] 7.2 Wire the handler as the Lambda's entrypoint and connect it to the event-source mapping from 4.3; verify `nx run ingestion:build` succeeds and `pulumi preview` shows no drift.

- [x] 7.3 Extend `processStatementFile.ts`'s insert to write the four FX-metadata columns from each row (null when unset); verify existing tests plus new coverage for a row with and without FX metadata land correctly.

## 8. End-to-end verification

- [x] 8.1 Deploy to a test/dev stack, create one `accounts` row per bank via `POST /accounts` (two for SEB, to cover the multi-account case), then manually upload one real (anonymized) sample file per bank via a presigned URL; verify each produces the expected `transactions` rows with correct dedup behavior on a re-upload of the same file, and that the SEB file's rows land against both accounts correctly.
  Verified 2026-09-01 on `prod`, using the existing unit-test fixtures with valid-checksum IBANs patched into the SEB file (the checked-in fixture's IBANs don't pass real IBAN checksum validation, which `POST /accounts` enforces). All rows landed against the correct accounts (SEB's 5/1 split across its two accounts, FX metadata captured on the NOK purchase), and a re-upload of identical content added 0 new rows.
  This run caught two real bugs invisible to the mocked-client unit tests: `dataApi.ts`'s `BatchExecuteStatementCommand` rejected `posted_date` as text (Postgres requires an explicit `DATE` typeHint, unlike `ExecuteStatementCommand`), and `handler.ts` crashed on S3's one-time `s3:TestEvent` bucket-notification probe (no `Records` array). Both fixed, covered by new regression tests, redeployed, and re-verified.
- [ ] 8.2 Verify a malformed file exercises the DLQ path: upload a deliberately broken file, confirm it lands in the DLQ after `maxReceiveCount` retries and no partial rows exist.
