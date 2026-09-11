## Purpose

Moves an uploaded statement file from S3 to durably-written `transactions` rows,
bank-agnostically: dispatch to the right parser, write everything for one file
atomically, and never lose a file that fails to process.

## ADDED Requirements

### Requirement: Each uploaded file is processed exactly once into one transaction
For each object created under `uploads/`, the pipeline SHALL invoke the ingestion
Lambda, resolve the upload-selected account from the object key's `accountId`
segment, resolve that account's bank to dispatch to the matching parser, parse the
file, and write all resulting rows within a single database transaction
(begin → inserts → commit). Each row is written against its own resolved account
(see `account-management`'s per-row resolution requirement), which may differ from
the upload-selected account when the file spans multiple accounts. A failure partway
through parsing or writing SHALL leave no partial rows for that file.

#### Scenario: Successful file produces committed rows
- **WHEN** a valid CSV for a known bank is uploaded
- **THEN** every transaction row parsed from that file exists in `transactions` after
  processing completes

#### Scenario: Parse failure partway leaves no partial write
- **WHEN** a file parses successfully for its first N rows and then hits malformed data
- **THEN** none of that file's rows are committed to `transactions`

### Requirement: Processing order across files is not required for correctness
The pipeline SHALL NOT depend on the order in which uploaded files are processed for
dedup correctness. Two files processed concurrently, including two overlapping exports
for the same account, SHALL both complete without either silently corrupting the
other's rows.

#### Scenario: Two overlapping files processed concurrently
- **WHEN** two files covering an overlapping date range for the same account are
  processed at the same time
- **THEN** the overlapping transactions appear exactly once in `transactions`,
  regardless of which file's processing completed first

### Requirement: A file that repeatedly fails to process is retained for inspection
A file whose processing fails more than the configured maximum receive count SHALL be
moved to a dead-letter destination rather than discarded, and SHALL remain available
for inspection and reprocessing.

#### Scenario: Persistently malformed file lands in the dead-letter destination
- **WHEN** a file fails processing on every retry up to the configured maximum
- **THEN** the file's message is present in the dead-letter destination and no
  `transactions` rows were written for it

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
