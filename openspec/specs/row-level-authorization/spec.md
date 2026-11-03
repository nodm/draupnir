# row-level-authorization Specification

## Purpose

Establishes the ownership and sharing model every user-owned table must
follow — each row belongs to exactly one user, visibility can be extended to
another user per-resource, and access is re-evaluated on every request
rather than cached.

## Requirements


### Requirement: Every user-owned resource has exactly one owner
Access to user data SHALL be defined by account membership: each account has
one or more members, each with role `owner` or `viewer`, and every row of
account-scoped data (statement files, raw rows, transactions) belongs to
exactly one account. Every account SHALL have at least one `owner` member at
all times.

#### Scenario: A resource's owner is recorded at creation
- **WHEN** a user creates an account
- **THEN** that user is recorded as an `owner` member of it, and no other user
  is a member

#### Scenario: Last owner cannot be removed
- **WHEN** an account has exactly one `owner` member and a request removes that
  member or changes their role to `viewer`
- **THEN** the request is rejected and the membership is unchanged

### Requirement: Access to a resource is granted per-resource, not per-user
The system SHALL allow an account's owner to add another specific user as a
member of that specific account, giving that user access to that account's data
only, never to any of the owner's other accounts.

#### Scenario: A grant covers only the named resource
- **WHEN** an owner of account A adds another user as a `viewer` of account A
- **THEN** that user can read account A's data and cannot read any other
  account the owner belongs to that they were not separately added to

#### Scenario: Viewer can read but not import
- **WHEN** a `viewer` member requests account data
- **THEN** the request succeeds, while a request by that viewer to upload a
  statement or change membership for the account is rejected

### Requirement: Only a resource's owner may grant or revoke access to it
The system SHALL reject any attempt to add, remove, or change the role of an
account member made by a user who is not an `owner` member of that account.

#### Scenario: Owner creates a grant
- **WHEN** an `owner` member adds another user as a member of the account
- **THEN** the membership is created

#### Scenario: Non-owner is rejected from creating a grant
- **WHEN** a user who is not an `owner` member of an account (a `viewer` or a
  non-member) attempts to add a member to it
- **THEN** the attempt is rejected and no membership is created

### Requirement: Revoking access takes effect on the very next request
The system SHALL re-evaluate membership on every request; a removed membership
SHALL NOT continue to authorize access on any request made after the removal
completes.

#### Scenario: Revoked grant no longer authorizes access
- **WHEN** a member is removed from an account and then requests that
  account's data
- **THEN** that request is denied access to the account's data

### Requirement: A user always retains access to what they own
The system SHALL allow an account's `owner` members to access that account's
data on every request, independent of any other member's state.

#### Scenario: Owner accesses own resource with no grants involved
- **WHEN** an account's only member is its owner and the owner requests its data
- **THEN** the request succeeds
