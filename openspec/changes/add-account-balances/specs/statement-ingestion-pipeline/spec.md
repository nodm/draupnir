## MODIFIED Requirements

### Requirement: Processing order across files is not required for correctness
The pipeline SHALL NOT depend on the order in which uploaded files are
processed for the integrity of stored data: two files processed concurrently
SHALL both complete without either silently corrupting the other's rows. For
SEB, whose `dedup_key` is derived from the provider's own per-row transaction
id, overlapping exports SHALL dedup to exactly one transaction per account
regardless of processing order. Revolut and monobank's hash-fallback `dedup_key`
(see `bank-statement-parsers`) assigns `occurrence_index` independently per
file, so a true duplicate at a re-upload overlap boundary can still slip past
dedup if the two files' identical-looking rows are ordered differently. This is
a known, accepted limitation, not covered by this guarantee. Whether a file is
approved does depend on order: a file that does not connect to the stored
history is rejected (see `statement-validation`), so a file processed before its
predecessor is rejected and can be uploaded again after the predecessor is
stored. A rejection leaves nothing stored.

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

#### Scenario: A file processed before its predecessor is rejected, then accepted on retry
- **WHEN** February's file is processed before January's and is rejected as not
  connecting, and January's file is then approved and February's is uploaded
  again
- **THEN** February's file is approved and the stored history is continuous
