## REMOVED Requirements

### Requirement: Gaps against history are warnings, not rejections
**Reason**: Stored balances are only meaningful when history is continuous from
the account's opening balance, so a gap must stop the import instead of being
recorded as a warning.
**Migration**: Replaced by "Gaps against history reject the file". Files that
were accepted with a gap warning before this change stay stored; new imports
must connect to stored history, in order.

## ADDED Requirements

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
