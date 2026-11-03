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

### Requirement: The database enforces membership on every account-scoped read
The database SHALL return rows of account-scoped tables (`accounts`,
`account_members`, `statement_file_accounts`, `raw_rows`, `transactions`,
`transaction_sources`) only for accounts the identified caller is a member of.
File-level statement records (`statement_files`) SHALL be returned when approved
to members of their upload account or of any account the file resolved to, and
when rejected only to their uploader, because rejection reasons can quote other
accounts' rows. An uploader who is no longer a member SHALL NOT keep access to
an approved file. This
SHALL hold even when a query contains no membership filter, and SHALL NOT be
influenced by any object the caller creates in their session (such as
temporary tables).

#### Scenario: Filterless query returns only the caller's accounts' rows
- **WHEN** user B, a member of no account owned by user A, runs
  `SELECT * FROM transactions` with no `WHERE` clause
- **THEN** no transaction of user A's accounts is returned

#### Scenario: Rejected file is visible only to its uploader
- **WHEN** a `viewer` of the upload-selected account queries `statement_files`
- **THEN** rejected files uploaded by other users are not returned

#### Scenario: Approved file is visible to members of its upload account
- **WHEN** an `owner` of the upload-selected account queries `statement_files`
- **THEN** approved files uploaded by other members are returned, and approved
  files of accounts the caller is not a member of are not

#### Scenario: Approved file is visible through an account it resolved to
- **WHEN** a file was uploaded for account A but also resolved to account B, and
  an `owner` of B who is not a member of A queries `statement_files`
- **THEN** the approved file is returned

#### Scenario: A file cannot be exposed by forging a link
- **WHEN** an `owner` of an account who neither uploaded a file nor owns its
  upload account tries to link that file to their account, by inserting a
  per-account record or by rewriting an existing one's file or account
- **THEN** the database rejects the write and the file stays hidden from them

#### Scenario: Removed uploader loses access to an approved file
- **WHEN** the uploader of an approved file is no longer a member of any account
  the file belongs to and queries `statement_files`
- **THEN** that file is not returned

#### Scenario: Temporary table cannot fake membership
- **WHEN** a caller creates a temporary table named `account_members` containing
  a row that makes them an owner of another user's account, then queries
  `transactions`
- **THEN** that account's transactions are still not returned

#### Scenario: Shared account is visible to its viewer
- **WHEN** user B is a `viewer` member of account A1 and runs a filterless
  query on `transactions`
- **THEN** account A1's transactions are returned, and transactions of user A's
  other accounts are not

### Requirement: The database allows writes only to owners
The database SHALL reject inserts, updates, and deletes on account-scoped tables
unless the identified caller is an `owner` member of the affected row's account.
The one exception: an identified caller MAY create a new account, which records
that caller as its first `owner` member.

#### Scenario: Viewer cannot write through the database
- **WHEN** a `viewer` member of an account attempts to insert a
  `statement_files` row or a `transactions` row for that account directly
- **THEN** the database rejects the write

#### Scenario: Viewer cannot write source links
- **WHEN** a `viewer` member of an account attempts to insert, update, or delete
  a `transaction_sources` row for a transaction of that account
- **THEN** the database rejects the write

#### Scenario: Creating an account makes the caller its owner
- **WHEN** an identified caller creates an account
- **THEN** the account exists and the caller is its only `owner` member

#### Scenario: Database keeps the last owner
- **WHEN** an `owner` deletes or demotes the only `owner` row of an account
  directly through the database
- **THEN** the database rejects the write

#### Scenario: Caller cannot add themselves to someone else's account
- **WHEN** an identified caller who is not a member of an account attempts to
  insert an `account_members` row naming themselves for that account
- **THEN** the database rejects the write

### Requirement: An unidentified caller sees and changes nothing
When no caller identity has been set for the current database transaction, the
database SHALL return no rows from account-scoped tables and SHALL reject every
write to them.

#### Scenario: Query without identity returns nothing
- **WHEN** application code runs a query on `accounts` without first setting a
  caller identity
- **THEN** the query returns zero rows rather than an error-free full result

### Requirement: Caller identity is scoped to one database transaction
The caller identity used by the database SHALL be set for a single database
transaction only, and SHALL NOT persist into any later transaction, even one
served by the same pooled database session.

#### Scenario: Identity does not leak into the next request
- **WHEN** a transaction runs with user A's identity and commits, and the next
  transaction on the same database session sets no identity
- **THEN** the next transaction sees no rows from account-scoped tables
