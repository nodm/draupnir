# statement-validation Specification

## Purpose

Decides, per bank and export format, whether a statement file is approved or
rejected as a whole, and reports how completely each account's history is
covered — so a missing, duplicated, or misparsed row is caught at import time
instead of silently skewing balances.

## Requirements

### Requirement: A file is approved or rejected as a whole
The system SHALL validate a file completely before writing any of its rows.
If any hard-reject rule fails, the whole file SHALL be rejected and none of its
rows written. Every failed rule SHALL be reported as a reason; for row-level
failures the reason SHALL identify the row number.

#### Scenario: One bad row rejects the file
- **WHEN** a file has 200 valid rows and one row with an unparseable amount
- **THEN** the file is rejected with a reason naming that row, and none of the
  201 rows are written

### Requirement: Format is detected and checked per bank and format version
The system SHALL detect each file's format version from its header for the
bank of the account it was uploaded for, and SHALL check every row against that
format's expected columns and value formats. A file SHALL be rejected when:
- its header matches no known format version for that bank;
- its header contains a duplicate column name;
- a required cell is missing or malformed;
- a row's currency differs from the currency of the account that row resolves
  to (each row's own account in a multi-account file, otherwise the
  upload-selected account). This applies to every row of the file, including
  rows kept out of `transactions`.

#### Scenario: Unknown format is rejected
- **WHEN** a Revolut account's upload has a header that matches no known
  Revolut format version
- **THEN** the file is rejected with an "unrecognized format" reason

#### Scenario: Duplicate header is rejected
- **WHEN** a file's header row contains the same column name twice
- **THEN** the file is rejected with a reason naming the duplicated column

#### Scenario: Currency mismatch is rejected
- **WHEN** a row's currency differs from the currency of the account that row
  resolves to
- **THEN** the file is rejected with a reason naming that row

### Requirement: Balances inside a file must chain
For formats that provide a per-row balance (Revolut and monobank at the time of
writing), the system SHALL check, in the bank's chronological order and over
rows that affect the balance, that each row's balance equals the previous row's
balance plus that row's amount minus its fee. A break SHALL reject the file,
and the reason SHALL include the row number and the expected and actual
balances. Formats without a per-row balance SHALL skip this rule.

#### Scenario: Consistent balance chain passes
- **WHEN** consecutive Revolut rows have balances 11.62 then 11.33 and the
  second row's amount is -0.29 with fee 0.00
- **THEN** the chain check passes for that pair

#### Scenario: Broken chain rejects the file
- **WHEN** a row's balance differs from previous balance + amount − fee
- **THEN** the file is rejected with a reason giving that row number and the
  expected and actual balances

#### Scenario: Rows that do not affect the balance are skipped
- **WHEN** a Revolut file contains a `PENDING` or `DECLINED` row between two
  `COMPLETED` rows
- **THEN** the chain check ignores that row and compares the two `COMPLETED`
  rows directly

### Requirement: A file must agree with already-stored transactions
When a file's transactions overlap transactions already stored for the same
account (same dedup key), the system SHALL reject the file if any overlapping
transaction differs in posted date, amount, currency, fee, or balance-after.
This check, the duplicate-file check, and the continuity check SHALL be
evaluated against history that cannot change before the file's outcome is
committed. Concurrent files for the same account SHALL therefore never both be
approved when they conflict with each other.

#### Scenario: Matching overlap is accepted
- **WHEN** a file overlaps a previously imported period and every overlapping
  transaction matches what is stored
- **THEN** the overlap rule passes, and the overlapping transactions gain an
  additional source instead of being duplicated

#### Scenario: Conflicting overlap rejects the file
- **WHEN** an overlapping transaction in the new file has a different amount
  than the stored one
- **THEN** the file is rejected with a reason naming the row and the conflicting
  stored transaction's date and amount

#### Scenario: Concurrent conflicting files
- **WHEN** two SEB files for the same account, containing the same provider
  transaction id with different amounts, are processed at the same time
- **THEN** exactly one is approved, and the other is rejected with a conflicting
  overlap reason

### Requirement: Gaps against history reject the file
The system SHALL decide continuity between an account's approved files from
evidence the exports provide, never from days without transactions:
- **Balance formats:** two adjacent files are continuous when the earlier
  one's closing balance for the account equals the later one's opening
  balance, or when their activity periods overlap (overlapping files must
  already agree on every shared transaction, so the boundary balances of an
  overlapping export legitimately differ). The first file connects to the account's opening when its opening
  balance equals the account's opening balance.
- **Formats with a declared period:** two files are continuous when their
  declared periods touch or overlap. The first connects to the opening when
  its declared start is on or before the account's opening date.
- **Formats with neither:** continuity is unknown.

A detected gap, including a first file that does not connect to the account's
opening, SHALL reject the file, store nothing from it, and name in its reason
the period that must be imported first (where stored history ends and where the
file starts, or where the file ends and stored history starts). Unknown
continuity SHALL NOT reject a file and SHALL be reported as unknown, not as a
gap.

#### Scenario: Out-of-order import is rejected
- **WHEN** an account has January imported and a March file is uploaded whose
  opening balance differs from January's closing balance
- **THEN** the March file is rejected, nothing from it is stored, and the reason
  names that history ends in January and the file starts in March, so February
  must be imported first

#### Scenario: Overlapping statements are continuous
- **WHEN** a balance-format file's period overlaps the previous file's and
  their shared transactions agree, although the later file's opening balance
  differs from the earlier file's closing balance
- **THEN** the file is not rejected for continuity

#### Scenario: Connected import has no warning
- **WHEN** a file's opening balance equals the previous file's closing balance
- **THEN** the file is not rejected for continuity

#### Scenario: Days without activity are not a gap
- **WHEN** an SEB file declares the period 1–31 January but contains
  transactions only on 5–27 January, and the next file declares 1–28 February
- **THEN** no gap is reported for 1–4 or 28–31 January

#### Scenario: No evidence means unknown, not a gap
- **WHEN** two adjacent files come from a format with neither balances nor a
  declared period
- **THEN** the continuity between them is reported as unknown and the later file
  is not rejected for it

#### Scenario: First file must connect to the account's opening
- **WHEN** the first file imported for an account has an opening balance that
  differs from the account's opening balance
- **THEN** the file is rejected naming the account's opening balance and date,
  and nothing from it is stored

#### Scenario: Earlier statement uploaded after a later one is rejected
- **WHEN** an account has February stored and a January file whose closing
  balance differs from February's opening balance is uploaded
- **THEN** the January file is rejected naming where it ends and where stored
  history starts

### Requirement: Account coverage and gaps can be reported
The system SHALL provide, per account:
- the periods covered by approved files (the declared period when the format
  states one, otherwise the first and last transaction dates);
- the continuity between adjacent periods (continuous, gap, or unknown);
- the latest date up to which history is continuous from the account's
  opening ("reconciled up to").

The report SHALL be available to every member of the account, including for
files where it was not the upload-selected account.

#### Scenario: Coverage report lists gaps
- **WHEN** an account has approved files covering January and March only, and
  their balances do not connect
- **THEN** its coverage report lists both periods, reports a gap between them,
  and reports "reconciled up to" no later than the end of January

#### Scenario: Coverage of a non-selected account
- **WHEN** account B's history comes only from a multi-account SEB file
  uploaded with account A selected
- **THEN** B's members see that file's period in B's coverage report
