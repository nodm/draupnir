## Purpose

Keeps a complete, lossless record of every imported statement — which file was
imported, whether it was approved or rejected and why, and every row exactly as
the bank exported it — so the common transactions table can always be
re-derived without re-uploading anything.

## ADDED Requirements

### Requirement: Every import attempt is recorded as a statement file
The system SHALL record each processed upload as a `statement_files` row with:
- the account it was uploaded for and the uploading user;
- bank and detected format version;
- the SHA-256 of the file contents and the file's S3 object key;
- status `approved` or `rejected`;
- rejection reasons (for `rejected`) and warnings (for either status);
- the period the file covers (first and last posted date), when determinable;
- the time it was processed.

#### Scenario: Approved file is recorded
- **WHEN** a valid statement file is processed
- **THEN** a `statement_files` row exists for it with status `approved`, its
  SHA-256, format version, covered period, and any warnings

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
