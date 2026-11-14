## MODIFIED Requirements

### Requirement: Users can list their accounts

`/accounts` SHALL list every account the caller is a member of as one visually
separated block per account. Each block SHALL show the display name as a heading, then
bank, masked IBAN (last 4 characters), currency and the caller's role, then the
account's current balance, then the "reconciled up to" date (or that the account is
not reconciled yet). The balance SHALL be the stored account balance (see
`account-balances`), formatted in the account's currency with the date it is as of,
and SHALL be marked as not reconciled when the stored balance is not reconciled. The
display name SHALL be emphasised and the masked IBAN SHALL be shown in monospace. No
account the caller is not a member of SHALL appear.

#### Scenario: Owned and shared accounts are listed

- **WHEN** a user who owns one account and views another sends `/accounts`
- **THEN** both are listed, each as its own block, with roles `owner` and `viewer`, and
  no other account appears

#### Scenario: An account's details are readable at a glance

- **WHEN** a user sends `/accounts`
- **THEN** each account's name is bold on its own line, followed by its bank, masked
  IBAN, currency and role on one line, its balance on the next, and its reconciliation
  status on the line after, with a blank line before the next account

#### Scenario: Balance is shown with its date

- **WHEN** an account in EUR has a stored balance of 106950 minor units as of 2026-08-29
- **THEN** its block shows a balance of 1069.50 EUR as of 2026-08-29

#### Scenario: Balance respects the currency's decimals

- **WHEN** an account in JPY has a stored balance of 1500 minor units
- **THEN** its block shows 1500 JPY, without decimals

#### Scenario: Negative balance is shown as negative

- **WHEN** an account has a stored balance of -2000 minor units in EUR
- **THEN** its block shows -20.00 EUR

#### Scenario: Unreconciled balance is flagged

- **WHEN** an account's stored balance is not reconciled
- **THEN** its balance line says it is not reconciled
