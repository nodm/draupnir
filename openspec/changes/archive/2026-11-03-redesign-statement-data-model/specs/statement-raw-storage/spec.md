## Purpose

Keeps a complete, lossless record of every imported statement — which file was
imported, whether it was approved or rejected and why, and every row exactly as
the bank exported it — so the common transactions table can always be
re-derived without re-uploading anything.

## ADDED Requirements

### Requirement: Every import attempt is recorded as a statement file
The system SHALL record each processed upload as one file-level record with:
- the account it was uploaded for and the uploading user;
- bank and detected format version (absent when the file's format was not
  recognized, as in unknown-format and duplicate-header rejections);
- the SHA-256 of the file contents and the file's S3 object key;
- status `approved` or `rejected`;
- rejection reasons (for `rejected`);
- the time it was processed.

For an approved file, the system SHALL also record, for each account the
file's rows resolved to, a per-account record with:
- the period the export declares, when the format states one;
- the first and last transaction dates for that account;
- the opening and closing balance for that account, when the format provides
  balances;
- the number of newly created transactions;
- that account's warnings.

The file-level record SHALL be visible only to its uploader. Each per-account
record SHALL be visible to members of its own account (see
`row-level-authorization`).

#### Scenario: Approved file is recorded
- **WHEN** a valid statement file is processed
- **THEN** a file-level record exists for it with status `approved`, its
  SHA-256 and format version, and a per-account record exists for each
  resolved account with its periods, balances, new-transaction count, and
  warnings

#### Scenario: Multi-account file is visible per account
- **WHEN** an approved SEB file has rows for account A (upload-selected) and
  account B, and user V is a member of B only
- **THEN** V can see B's per-account record for that file, and cannot see A's
  per-account record or the file-level record

#### Scenario: Declared period is kept separate from activity
- **WHEN** an approved SEB file's title declares the period 2026-01-01 to
  2026-01-31 and its first and last transactions are on 2026-01-05 and
  2026-01-27
- **THEN** the per-account record holds both the declared period and the
  activity dates, unchanged

#### Scenario: Rejected file is recorded with reasons
- **WHEN** a statement file fails validation
- **THEN** a `statement_files` row exists for it with status `rejected` and at
  least one human-readable rejection reason, and no `raw_rows` or
  `transactions` rows are written for it

### Requirement: Re-uploading an already imported file is rejected
The system SHALL reject a file whose SHA-256 matches an `approved` file already
imported for the same account, recording the rejection with a reason that names
the earlier import.

#### Scenario: Same file uploaded twice
- **WHEN** a file is uploaded for an account and a file with the same SHA-256
  was already approved for that account
- **THEN** the new upload is recorded as `rejected` with a "duplicate of an
  earlier import" reason, and no rows are written

#### Scenario: Same file for a different account is not treated as a duplicate
- **WHEN** a file with a given SHA-256 was approved for account A and the same
  bytes are uploaded for account B
- **THEN** the duplicate-upload rule does not reject it (other validation rules
  still apply)

### Requirement: Raw rows preserve the bank's data exactly
For an approved file, the system SHALL store every data row of the file as a
`raw_rows` row whose payload maps each original column header to that cell's
value as the original string, without parsing, trimming, or reformatting
values. Each raw row SHALL record its file, its 1-based row number within the
file, the bank, the format version, and the bank's own transaction identifier
when the format provides one.

#### Scenario: Values are stored as exported
- **WHEN** an approved SEB file contains the amount cell `50,00` and a monobank
  file contains the cell `—`
- **THEN** the corresponding raw-row payloads contain the strings `"50,00"` and
  `"—"` unchanged

#### Scenario: Every data row is stored, including rows excluded from transactions
- **WHEN** an approved Revolut file contains `COMPLETED` and `PENDING` rows
- **THEN** every one of those rows exists in `raw_rows`, including the
  `PENDING` ones

#### Scenario: Overlapping files keep both copies of a shared row
- **WHEN** two approved files for the same account both contain the same
  transaction
- **THEN** `raw_rows` contains one row from each file for it

### Requirement: Common transactions can be rebuilt from raw rows
Deriving `transactions` and `transaction_sources` from `raw_rows` SHALL be
deterministic. The system SHALL provide an operation that rebuilds them for a
given account from that account's stored raw rows of approved files, producing
the same result as the original imports when the derivation logic is unchanged.

#### Scenario: Rebuild reproduces the original result
- **WHEN** the rebuild operation runs for an account and derivation logic has
  not changed since import
- **THEN** the account's `transactions` and `transaction_sources` are identical
  (ignoring generated ids and timestamps) to those before the rebuild

#### Scenario: Rebuild applies a fixed derivation
- **WHEN** a normalization bug is fixed and the rebuild runs for an account
- **THEN** the account's transactions reflect the fixed normalization without
  any file being re-uploaded

#### Scenario: Rebuild of a non-selected account in a multi-account file
- **WHEN** account B's only transactions came from an SEB file uploaded with
  account A selected, and the rebuild runs for account B
- **THEN** B's transactions are rebuilt from B's raw rows of that file, and A's
  transactions are untouched

### Requirement: A redelivered upload returns its recorded outcome
Processing the same S3 object again after its outcome was committed (for
example a queue redelivery) SHALL NOT create a second file record or change any
data. It SHALL return the outcome already recorded for that object.

#### Scenario: Redelivery after commit
- **WHEN** an upload was approved and committed, and its queue message is
  delivered again
- **THEN** no new file record is created, the file is not rejected as a
  duplicate of itself, and the recorded approval is returned
