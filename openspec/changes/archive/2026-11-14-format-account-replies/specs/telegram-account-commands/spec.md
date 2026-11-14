## MODIFIED Requirements

### Requirement: Users can list their accounts
`/accounts` SHALL list every account the caller is a member of as one visually
separated block per account. Each block SHALL show the display name as a heading, then
bank, masked IBAN (last 4 characters), currency and the caller's role, then the
"reconciled up to" date (or that the account is not reconciled yet). The display name
SHALL be emphasised and the masked IBAN SHALL be shown in monospace. No account the
caller is not a member of SHALL appear.

#### Scenario: Owned and shared accounts are listed
- **WHEN** a user who owns one account and views another sends `/accounts`
- **THEN** both are listed, each as its own block, with roles `owner` and `viewer`, and
  no other account appears

#### Scenario: An account's details are readable at a glance
- **WHEN** a user sends `/accounts`
- **THEN** each account's name is bold on its own line, followed by its bank, masked
  IBAN, currency and role on one line, and its reconciliation status on the next, with
  a blank line before the next account

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
