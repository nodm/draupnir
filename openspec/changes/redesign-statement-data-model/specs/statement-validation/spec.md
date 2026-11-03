## Purpose

Decides, per bank and export format, whether a statement file is approved or
rejected as a whole, and reports how completely each account's history is
covered — so a missing, duplicated, or misparsed row is caught at import time
instead of silently skewing balances.

## ADDED Requirements

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
- a row's currency differs from the account's currency.

#### Scenario: Unknown format is rejected
- **WHEN** a Revolut account's upload has a header that matches no known
  Revolut format version
- **THEN** the file is rejected with an "unrecognized format" reason

#### Scenario: Duplicate header is rejected
- **WHEN** a file's header row contains the same column name twice
- **THEN** the file is rejected with a reason naming the duplicated column

#### Scenario: Currency mismatch is rejected
- **WHEN** a row's currency differs from the currency of the account the file
  was uploaded for
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

### Requirement: Gaps against history are warnings, not rejections
For formats with balances, the system SHALL compare the balance before a file's
first row with the balance expected from stored history. That expected balance
is the latest stored balance-after before the file's period or, when nothing
earlier is stored and the file starts on the account's opening date, the
account's opening balance. A mismatch, or a period with no stored data between
covered periods, SHALL be recorded as a warning on the file and SHALL NOT reject
it.

#### Scenario: Out-of-order import is accepted with a warning
- **WHEN** an account has March imported and a file for January is uploaded
- **THEN** the January file is approved, and a gap warning is recorded for
  February

#### Scenario: Connected import has no warning
- **WHEN** a file's starting balance equals the last stored balance before its
  period
- **THEN** the file is approved with no continuity warning

### Requirement: Account coverage and gaps can be reported
The system SHALL provide, per account, the periods covered by approved files,
the gaps between them, and the latest date up to which history is continuous
from the opening balance ("reconciled up to").

#### Scenario: Coverage report lists gaps
- **WHEN** an account has approved files covering January and March only
- **THEN** its coverage report lists both periods, reports February as a gap,
  and reports "reconciled up to" no later than the end of January
