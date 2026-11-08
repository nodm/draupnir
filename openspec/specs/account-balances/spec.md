# account-balances Specification

## Purpose
Keeps an actual balance for every account and a running balance on every
transaction, so questions about an account's current state are answered from
stored, bank-checked values instead of by summing history on every request.

## Requirements

### Requirement: An account stores its current balance
Each account SHALL store its current balance in minor units, the date the
balance is as of (the date on which the balance last changed, that is the date
of the latest transaction's order time, or the opening date when there are
none), and whether the balance is reconciled. The
balance SHALL equal the opening balance plus the sum of every stored
transaction's amount minus its fee, and SHALL be recomputed from those values,
never adjusted by an increment. The balance is reconciled only when history is
continuous from the account's opening balance to the account's latest imported
statement, and a reconciled balance SHALL NOT be reported when any continuity
between stored statements is a gap or unknown.

A newly created account's balance SHALL be its opening balance, as of its
opening date, and reconciled.

#### Scenario: New account starts at its opening balance
- **WHEN** an account is created with an opening balance of 1000.00 on
  2026-01-01
- **THEN** its balance is 1000.00, as of 2026-01-01, and reconciled

#### Scenario: Balance follows imported transactions
- **WHEN** an approved file adds transactions of −30.00 with a 0.50 fee and
  +100.00 to an account whose balance was 1000.00
- **THEN** the account balance is 1069.50, as of the date of the latest of those
  transactions' order times

#### Scenario: As-of date is the day the balance changed
- **WHEN** a Revolut transaction was started on 2026-08-28 and completed on
  2026-08-29, and it is the latest transaction
- **THEN** the account balance is as of 2026-08-29

#### Scenario: Importing the same file again does not change the balance
- **WHEN** a file whose transactions are already stored is processed again and
  rejected as a duplicate
- **THEN** the account balance is unchanged

### Requirement: Every transaction stores a running balance
Each transaction SHALL store the account's balance immediately after it:
the opening balance plus the sum of the amount minus the fee of every
transaction up to and including it, in the transaction order. This is computed
for every bank and SHALL be stored separately from the bank-reported
balance-after, which is kept unchanged.

#### Scenario: Running balance on a bank without per-row balances
- **WHEN** an SEB file is imported
- **THEN** each of its transactions has a running balance although the file
  carries no per-row balance

#### Scenario: Bank-reported balance is kept separately
- **WHEN** a Revolut file is imported
- **THEN** each transaction has both the bank-reported balance-after and the
  computed running balance, and neither overwrites the other

### Requirement: Transactions have a stable order
Transactions of an account SHALL be ordered by the time the balance changed,
then by their position in their source file's chronological order, then by
their dedup key (stable across a rebuild, unlike ids), then by id.
The time is the bank's own timestamp where its export has one (for Revolut,
the completion time, because the balance changes on completion) and otherwise
the posted date at midnight. The order SHALL be reproducible when the account is
rebuilt from raw rows.

#### Scenario: Same-day rows keep the bank's chronological order
- **WHEN** a monobank file, exported newest first, has three transactions on one
  day
- **THEN** their running balances follow the order in which the balance
  actually changed, oldest first

#### Scenario: Rebuild reproduces the order
- **WHEN** an account is rebuilt from its raw rows
- **THEN** every transaction has the same order key and running balance as
  before the rebuild

### Requirement: Balances are recomputed in the import transaction under the account lock
When a file is approved, the system SHALL recompute, for every account the file
touches, the running balance of every transaction of that account and the
account balance, within the same database transaction that stores the file's
rows, while holding the lock that serializes imports of that account. Locks on
several accounts SHALL be taken in a fixed order. A failure at any point SHALL
leave the previous balances in place.

#### Scenario: Concurrent imports into one account serialize
- **WHEN** two approved files for the same account are processed at the same
  time
- **THEN** the second waits for the first, and afterwards the account balance
  equals the opening balance plus the sum of every stored transaction

#### Scenario: A failed import leaves balances untouched
- **WHEN** a database write fails after an import has recomputed some balances
- **THEN** neither the file's rows nor any balance change is committed

### Requirement: An import must agree with the bank's closing balance
For a format that reports balances, the system SHALL reject a file, storing
nothing, when the account's computed balance after the file's last transaction
differs from the file's closing balance. The rejection SHALL state both amounts.
For a format that reports no balance (SEB) there is nothing to compare, the file
SHALL NOT be rejected on this ground, and its continuity relies on declared
periods.

#### Scenario: Computed balance differs from the closing balance
- **WHEN** a Revolut file's closing balance is 1500.00 but opening plus stored
  history plus the file gives 1490.00
- **THEN** the file is rejected naming 1500.00 and 1490.00, and no transaction,
  raw row or balance is stored

#### Scenario: Matching closing balance is approved
- **WHEN** the computed balance after the file's last transaction equals its
  closing balance
- **THEN** the file is approved

#### Scenario: SEB file is accepted without a balance check
- **WHEN** an SEB file that connects by declared period is imported
- **THEN** it is approved, and the account balance is computed from its
  transactions without comparison to a bank balance

### Requirement: Rebuilding an account recomputes its balances
Rebuilding an account from its raw rows SHALL recompute its order keys,
running balances, and account balance under the same lock imports take.

#### Scenario: Balances are recomputed after a rebuild
- **WHEN** an account is rebuilt
- **THEN** its stored balance equals its opening balance plus the sum of its
  transactions' amounts minus fees

### Requirement: Existing accounts are backfilled without losing data
The system SHALL give every existing account a stored balance, and every
existing transaction an order key and a running balance, without deleting or
replacing existing rows. An existing account SHALL be reported reconciled only
when its coverage shows no gap and connects to its opening.

#### Scenario: Backfill keeps existing rows
- **WHEN** the balances of an account with imported transactions are backfilled
- **THEN** every existing transaction keeps its id and the account has a balance
  and a reconciled flag

#### Scenario: Account with a gap is not reported reconciled
- **WHEN** an existing account's coverage contains a gap
- **THEN** its balance is stored and its reconciled flag is false
