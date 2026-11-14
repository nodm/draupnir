# telegram-account-commands Specification

## Purpose

Gives linked users the account operations Draupnir needs through bot commands
(listing, creating, sharing, and coverage), since there is no web app.

## Requirements

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

### Requirement: Users can create an account through a guided dialogue
`/newaccount` SHALL ask, one step at a time, for:
1. bank (buttons from the supported-bank list);
2. IBAN;
3. currency;
4. display name;
5. opening date;
6. opening balance.

Each answer SHALL be validated before the next question (IBAN checksum, ISO
currency code, a date not in the future, numeric balance). The bot SHALL then
show a summary and create the account only after the user taps confirm, which
makes the caller its owner. `/cancel` SHALL abandon the dialogue at any step,
and an unfinished dialogue SHALL expire after 1 hour.

#### Scenario: Completed dialogue creates the account
- **WHEN** a user answers every step with valid values and taps confirm
- **THEN** the account exists with those values and the user is its `owner`

#### Scenario: Invalid IBAN is asked again
- **WHEN** a user enters an IBAN with a wrong checksum
- **THEN** the bot explains the problem and asks for the IBAN again, without
  advancing

#### Scenario: Existing IBAN explains how to get access
- **WHEN** the confirmed IBAN already belongs to an account
- **THEN** no account is created, and the bot says an owner of that account must
  `/share` it with the user

### Requirement: Owners can share and unshare an account
`/share` SHALL let an `owner` pick one of their accounts, enter the email of
another registered Draupnir user, and pick a role (`viewer` or `owner`).
`/unshare` SHALL let an owner remove a member. Both SHALL follow the membership
rules of `row-level-authorization` (owner only, at least one owner remains).
The added or removed user SHALL be notified in their own chat if they are
linked.

#### Scenario: Owner shares with a registered user
- **WHEN** an owner shares an account with the email of a registered user as
  `viewer`
- **THEN** that user becomes a `viewer` member, and receives a notification if
  linked

#### Scenario: Unknown email is refused
- **WHEN** an owner enters an email that belongs to no registered Draupnir user
- **THEN** no membership is created and the bot says that person must sign in to
  Draupnir first

#### Scenario: Removing the last owner is refused
- **WHEN** the only owner tries to `/unshare` themselves
- **THEN** the membership is unchanged and the bot explains why

### Requirement: Users can see an account's coverage
`/coverage` SHALL show, for an account the caller is a member of, the covered
periods, the gaps, and the "reconciled up to" date (see `statement-validation`). The
reply SHALL start with an emphasised account heading and the reconciliation status,
and SHALL present each of "Imported periods", "Gaps" and "Unclear" as its own titled
section, with dates in monospace.

#### Scenario: Coverage with a gap
- **WHEN** a user asks for coverage of an account with January and March imported
- **THEN** the reply lists both periods and February as a gap, the gap under its own
  "Gaps" title

#### Scenario: Coverage without problems has no empty sections
- **WHEN** a user asks for coverage of an account whose periods connect without gaps
- **THEN** the reply has no "Gaps" or "Unclear" section
