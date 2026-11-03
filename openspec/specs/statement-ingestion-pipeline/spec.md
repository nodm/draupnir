# statement-ingestion-pipeline Specification

## Purpose

Moves an uploaded statement file from S3 to durably-written `transactions` rows,
bank-agnostically: dispatch to the right parser, write everything for one file
atomically, and never lose a file that fails to process.

## Requirements

### Requirement: Each uploaded file is processed exactly once into one transaction
For each object created under `uploads/`, the pipeline SHALL:
1. invoke the ingestion Lambda;
2. resolve the upload-selected account from the object key's `accountId`
   segment;
3. resolve that account's bank to dispatch to the matching parser;
4. parse and validate the whole file (see `statement-validation`);
5. write the outcome within a single database transaction (begin → writes →
   commit).

For an approved file, that transaction SHALL contain the `statement_files` row,
one per-account record for each resolved account, every `raw_rows` row, and the
derived `transactions` and `transaction_sources` rows. Checks that depend on
stored history SHALL run inside that transaction, against history that can't
change before it commits (see `statement-validation`). Each derived transaction is written against its own resolved account
(see `account-management`'s per-row resolution requirement), which may differ
from the upload-selected account when the file spans multiple accounts. For a
rejected file, the transaction SHALL contain only the `statement_files` row
with its rejection reasons. A failure partway through SHALL leave no partial
rows for that file.

#### Scenario: Successful file produces committed rows
- **WHEN** a valid CSV for a known bank is uploaded
- **THEN** after processing, the file's `statement_files` row is `approved`,
  every data row exists in `raw_rows`, and every transaction derived from it
  exists in `transactions` with a source link

#### Scenario: Parse failure partway leaves no partial write
- **WHEN** a database write fails after some of a file's rows were written
  within its transaction
- **THEN** none of that file's `statement_files`, `raw_rows`, or `transactions`
  rows are committed

#### Scenario: Validation failure is recorded, not retried
- **WHEN** a file fails validation
- **THEN** its `statement_files` row is committed as `rejected` with reasons,
  the message is acknowledged rather than retried, and nothing reaches the
  dead-letter destination

### Requirement: Processing order across files is not required for correctness
The pipeline SHALL NOT depend on the order in which uploaded files are
processed: two files processed concurrently SHALL both complete without either
silently corrupting the other's rows. For SEB, whose `dedup_key` is derived
from the provider's own per-row transaction id, overlapping exports SHALL
dedup to exactly one transaction per account regardless of processing order.
Revolut and monobank's hash-fallback `dedup_key` (see
`bank-statement-parsers`) assigns `occurrence_index` independently per file,
so a true duplicate at a re-upload overlap boundary can still slip past dedup
if the two files' identical-looking rows are ordered differently. This is a
known, accepted limitation, not covered by this guarantee. Continuity with
stored history is checked as a warning only (see `statement-validation`), so
importing files out of chronological order SHALL NOT cause a rejection by
itself.

#### Scenario: Two overlapping SEB files processed concurrently
- **WHEN** two SEB files covering an overlapping date range for the same account
  are processed at the same time
- **THEN** the overlapping transactions appear exactly once in `transactions`,
  each linked to a raw row from both files, regardless of which file's
  processing completed first

#### Scenario: Concurrent processing never corrupts either file's rows
- **WHEN** two files for any bank are processed at the same time
- **THEN** each file's own non-overlapping rows are written correctly,
  regardless of the other file's processing order or outcome

#### Scenario: The same file uploaded twice concurrently is approved once
- **WHEN** the same file is uploaded twice for the same account and both copies
  are processed at the same time
- **THEN** exactly one copy is `approved` and the other is `rejected` as a
  duplicate

### Requirement: An unresolvable account in the object key is not silently dropped
If the `accountId` segment of an uploaded object's key does not resolve to an
existing account (deleted between presigned-URL issuance and upload, for example),
the pipeline SHALL treat this as a processing failure subject to the same retry/DLQ
behavior as a parse error, rather than silently discarding the file.

#### Scenario: Object key names an account that no longer resolves
- **WHEN** an object is uploaded under a key whose `accountId` segment does not
  resolve to an existing `accounts` row
- **THEN** the file follows the same retry-then-DLQ path as any other processing
  failure

### Requirement: A file that repeatedly fails unexpectedly is retained for inspection
A file whose processing fails with an unexpected error (not a validation
rejection) more than the configured maximum receive count SHALL be moved to a
dead-letter destination rather than discarded, and SHALL remain available for
inspection and reprocessing.

#### Scenario: Persistently failing file lands in the dead-letter destination
- **WHEN** a file's processing raises an unexpected error on every retry up to
  the configured maximum
- **THEN** the file's message is present in the dead-letter destination and no
  `statement_files`, `raw_rows`, or `transactions` rows were written for it

### Requirement: A rejection by a non-owner is reported but not recorded
When the uploader is not an `owner` member of the upload-selected account at
processing time (for example, ownership was revoked after the presigned URL was
issued), or the account is not visible to them at all (removed member, or the
account no longer exists, which the database does not distinguish), the pipeline SHALL reject the file with the reason `not-owner` and
SHALL NOT write a `statement_files` row, because the database refuses writes by
non-owners. The message SHALL be acknowledged rather than retried, and nothing
SHALL reach the dead-letter destination. The outcome has no file id.

#### Scenario: Uploader who lost ownership is rejected without a record
- **WHEN** a file is processed for an uploader who is no longer an `owner` of
  the upload-selected account
- **THEN** the outcome is `rejected` with reason `not-owner` and no file id, no
  `statement_files` row exists for the object, and the message is acknowledged
