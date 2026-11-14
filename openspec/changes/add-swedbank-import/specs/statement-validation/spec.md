## ADDED Requirements

### Requirement: Swedbank format is detected and checked
The system SHALL recognise the Swedbank export by its header (the 16 Lithuanian
column names in order, the second unnamed, optionally followed by one trailing empty
column) as format version `swedbank-v1`. The unnamed second column and the trailing
empty column SHALL NOT be reported as a duplicate header. Every row SHALL be checked:
a real ISO date, a currency code, a non-negative decimal amount with `.`, a `D/K`
marker of `D` or `K`, an account IBAN, and a row type of `10`, `20`, `82`, `86` or
`900`. The record number is optional and is not required for any row type.

#### Scenario: Real export header is recognised
- **WHEN** a Swedbank account's upload has the header of the sample exports
- **THEN** the format is detected as `swedbank-v1` with no duplicate-header reason

#### Scenario: Altered header is rejected
- **WHEN** a Swedbank account's upload has a header that matches no known version
- **THEN** the file is rejected with an "unrecognized format" reason

#### Scenario: Bad amount rejects the file
- **WHEN** a transaction row's amount is `12,5x`
- **THEN** the file is rejected with a reason naming that row

### Requirement: A Swedbank file's balances and turnover must reconcile
For each account in a Swedbank file, the system SHALL require exactly one opening
(`10`) and one closing (`86`) balance row, and SHALL check that opening balance plus
the sum of the account's transaction amounts equals the closing balance. Where
turnover (`82`) rows are present, their debit and credit totals SHALL equal the sums
of the account's debit and credit transaction amounts; an absent turnover row for a
direction means that direction's total is zero. Any mismatch SHALL reject the file,
and the reason SHALL include the expected and actual amounts.

#### Scenario: Consistent file passes
- **WHEN** a file's opening is 89.73, its transactions net +94.34, its closing is
  184.07, and its turnover rows equal the debit and credit sums
- **THEN** the reconciliation passes

#### Scenario: Missing transaction is caught
- **WHEN** a row has been removed from an otherwise intact file
- **THEN** the file is rejected because opening plus transactions differs from
  closing, with expected and actual balances in the reason

#### Scenario: Turnover disagrees with transactions
- **WHEN** the credit turnover row differs from the sum of credit transactions
- **THEN** the file is rejected naming the direction, expected and actual totals

#### Scenario: Missing closing balance
- **WHEN** a file has no closing-balance row for its account
- **THEN** the file is rejected

### Requirement: Swedbank files connect by their opening and closing balances
Swedbank exports state an opening and a closing balance per file, so the system SHALL
treat Swedbank as a balance format for continuity: two adjacent files are continuous
when the earlier closing balance equals the later opening balance (or their activity
periods overlap), and the first file connects to the account's opening when its
opening balance equals the account's opening balance. The file's stated period (the
opening-row and closing-row dates) SHALL be reported as its covered period.

#### Scenario: Consecutive yearly files are continuous
- **WHEN** a file closing at 1006.58 is followed by a file opening at 1006.58
- **THEN** the later file is not rejected for continuity

#### Scenario: Missing year is a gap
- **WHEN** an account has the 2022–2023 file stored and a file opening at 89.73 is
  uploaded
- **THEN** the file is rejected naming that history ends at the earlier closing
  balance and the file starts later, so the missing period must be imported first

#### Scenario: First file connects to the account opening
- **WHEN** the first file's opening balance is 0.00 and the account was created with
  opening balance 0
- **THEN** the file connects to the account's opening
