## MODIFIED Requirements

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

## REMOVED Requirements

### Requirement: A file that repeatedly fails to process is retained for inspection
**Reason**: A malformed file is now a validation rejection, recorded on its
`statement_files` row and never retried, so "persistently malformed file goes to
the DLQ" no longer holds. Dead-lettering is kept, but only for unexpected
errors.
**Migration**: Replaced by "A file that repeatedly fails unexpectedly is
retained for inspection" below. Look up rejected files by their
`statement_files` status and reasons instead of the DLQ.

## ADDED Requirements

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
