## ADDED Requirements

### Requirement: Swedbank parser reads one account per file from each row's IBAN
The Swedbank parser SHALL read the account IBAN from each row's own account-number
column and SHALL NOT assume the row belongs to the account selected at upload time.
It SHALL accept the export's comma-delimited, fully quoted layout, including rows
that carry fewer cells than the header (trailing empty cells omitted) and a header
with a trailing empty column.

#### Scenario: Rows carry the file's account IBAN
- **WHEN** the Swedbank parser processes a savings-account export
- **THEN** every parsed row carries that account's IBAN

#### Scenario: Short rows are accepted
- **WHEN** a row has fewer cells than the header because its trailing cells are
  empty
- **THEN** the missing cells read as empty strings and the row is parsed

### Requirement: Only Swedbank transaction rows enter transactions
The Swedbank parser SHALL produce a normalized row only for rows whose row-type
column is `20` (a posted transaction). Opening-balance (`10`), turnover (`82`),
closing-balance (`86`) and accrued-interest (`900`) rows SHALL be output with their
raw payload only. A row type outside these five SHALL fail the file.

#### Scenario: Balance and summary rows stay raw-only
- **WHEN** the Swedbank parser processes a file with an opening, two turnover and a
  closing row
- **THEN** each is output with its raw payload and none produces a normalized row

#### Scenario: Accrued interest is not a transaction
- **WHEN** a savings-account file ends with a `900` "accrued interest" row
- **THEN** it produces no normalized row; posted interest rows (type `20`) do

#### Scenario: Unknown row type fails the file
- **WHEN** a row has a row-type value other than `10`, `20`, `82`, `86`, `900`
- **THEN** the file is rejected naming that row

### Requirement: Swedbank amount sign comes from the D/K marker
The Swedbank parser SHALL read the amount as a positive decimal with `.` as the
separator and SHALL derive its sign from the `D/K` column: `K` (credit) is positive,
`D` (debit) is negative. Any other marker SHALL fail the file.

#### Scenario: Debit is negative, credit positive
- **WHEN** the parser processes a `20` row with amount `20.99` and marker `D`, and
  another with amount `254.40` and marker `K`
- **THEN** their normalized amounts are −2099 and +25440 minor units

### Requirement: Swedbank parser derives dedup_key from the record number
The Swedbank parser SHALL compute `dedup_key` as the row's record number
(`Įrašo Nr.`) namespaced with `swedbank:`, without hashing any other field. The
record number is not guaranteed present: a transaction row with an empty one SHALL
instead use the hash-fallback `dedup_key` (as Revolut and monobank, with
`occurrence_index` ranked among the file's fallback rows sharing identical values).

#### Scenario: Same record number dedups across files
- **WHEN** two Swedbank files with overlapping periods contain the same transaction
  row
- **THEN** both rows compute the same `dedup_key`

#### Scenario: Two same-day identical-looking purchases stay distinct
- **WHEN** a file contains two rows with identical date, amount and description but
  different record numbers
- **THEN** they compute different `dedup_key` values and both persist

#### Scenario: Empty record number falls back to the hash key
- **WHEN** a `20` row has an empty record number
- **THEN** its `dedup_key` is the hash of iban, date, amount, currency, normalized
  description and occurrence index, and the file is not rejected for it

#### Scenario: Identical fallback rows stay distinct
- **WHEN** a file has two `20` rows with empty record numbers and identical account,
  date, amount and description
- **THEN** they get `occurrence_index` 0 and 1 and distinct `dedup_key` values

### Requirement: Swedbank rows have no fee, balance-after or FX metadata
The Swedbank parser SHALL report fee as 0, SHALL leave balance-after absent (the
export has no per-row balance) and SHALL leave the FX metadata fields unset. The
transaction's order SHALL be its date at midnight, then its position in the file.

#### Scenario: Normalized row carries only amount, date, description
- **WHEN** the parser processes a `20` row
- **THEN** the normalized row has fee 0, no balance-after and no FX fields

### Requirement: Swedbank parser has a test fixture from a real anonymized sample
The Swedbank parser SHALL be validated against fixtures derived from real, anonymized
samples of both a current account and a savings account, covering at least: a card
purchase, a transfer, a posted-interest row, opening/turnover/closing rows, and a
short (trailing-cells-omitted) row.

#### Scenario: Fixture-driven test catches a dedup regression
- **WHEN** the Swedbank dedup-key computation changes
- **THEN** its fixture test fails if the change makes a previously-distinct pair of
  rows collide or a previously-equal pair diverge
