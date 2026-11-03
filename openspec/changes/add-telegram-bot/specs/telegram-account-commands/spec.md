## Purpose

Gives linked users the account operations Draupnir needs through bot commands
(listing, creating, sharing, and coverage), since there is no web app.

## ADDED Requirements

### Requirement: Users can list their accounts
`/accounts` SHALL list every account the caller is a member of, with display
name, bank, masked IBAN (last 4 characters), currency, the caller's role, and
the "reconciled up to" date. No account the caller is not a member of SHALL
appear.

#### Scenario: Owned and shared accounts are listed
- **WHEN** a user who owns one account and views another sends `/accounts`
- **THEN** both are listed with roles `owner` and `viewer`, and no other account
  appears

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
periods, the gaps, and the "reconciled up to" date (see `statement-validation`).

#### Scenario: Coverage with a gap
- **WHEN** a user asks for coverage of an account with January and March imported
- **THEN** the reply lists both periods and February as a gap
