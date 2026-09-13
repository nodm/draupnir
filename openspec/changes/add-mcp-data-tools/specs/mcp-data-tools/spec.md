## Purpose

Provides read-only MCP tools (`list_accounts`, `list_transactions`) that let an
authenticated caller retrieve their own and shared accounts/transactions
through the `mcp` server, scoped by the same ownership and share-grant rules
that govern every other user-owned resource.

## ADDED Requirements

### Requirement: list_accounts returns only caller-visible accounts
`list_accounts` SHALL return every `accounts` row the caller owns, plus any
`accounts` row shared with the caller via a `share_grants` row naming resource
type `account`. It SHALL NOT return any other account.

#### Scenario: Owned account is returned
- **WHEN** the caller calls `list_accounts` and owns an `accounts` row
- **THEN** that row is included in the result

#### Scenario: Shared account is returned
- **WHEN** another user owns an `accounts` row and has granted the caller
  access to it via `share_grants`
- **THEN** that row is included in the caller's `list_accounts` result

#### Scenario: Unshared account owned by another user is excluded
- **WHEN** another user owns an `accounts` row and has not shared it with the
  caller
- **THEN** that row is absent from the caller's `list_accounts` result

### Requirement: list_transactions returns only transactions on caller-visible accounts
`list_transactions` SHALL return a `transactions` row only if the caller owns
the account it references, or the account has been shared with the caller via
a `share_grants` row naming resource type `account`. Since a transaction's
`owner_user_id` always equals its account's owner (per the transactions-schema
spec) and never the grantee, visibility SHALL be evaluated against the
referenced account's ownership and grants, not the transaction row's own
`owner_user_id`.

#### Scenario: Transaction on an owned account is returned
- **WHEN** the caller calls `list_transactions` and owns the account a
  transaction belongs to
- **THEN** that transaction is included in the result

#### Scenario: Transaction on a shared account is returned
- **WHEN** an account has been shared with the caller and a transaction
  belongs to that account
- **THEN** that transaction is included in the caller's `list_transactions`
  result, even though its `owner_user_id` is the sharing user's, not the
  caller's

#### Scenario: Transaction on an unshared account owned by another user is excluded
- **WHEN** a transaction belongs to an account owned by another user who has
  not shared it with the caller
- **THEN** that transaction is absent from the caller's `list_transactions`
  result

### Requirement: list_transactions can filter by account
`list_transactions` SHALL accept an optional account filter. When supplied, it
SHALL return only transactions belonging to that account, and only if that
account is visible to the caller under the previous requirement. A filter
naming an account the caller cannot see SHALL yield an empty result, not an
error, so the tool never reveals whether an account id exists.

#### Scenario: Filtering by a visible account narrows results
- **WHEN** the caller calls `list_transactions` with an account filter naming
  an account they own or that is shared with them
- **THEN** only that account's transactions are returned

#### Scenario: Filtering by an invisible account yields an empty result
- **WHEN** the caller calls `list_transactions` with an account filter naming
  an account they cannot see
- **THEN** the result is an empty list, not an error

### Requirement: list_transactions paginates with a stable keyset cursor
`list_transactions` SHALL return results ordered most-recent-first and SHALL
limit each response to a bounded page size (a caller-supplied size within a
fixed maximum, or a fixed default when omitted). When more matching rows exist
beyond the page, the response SHALL include a cursor that, supplied on a
subsequent call, continues immediately after the last row already returned,
without omitting or repeating a row across pages whose underlying data does
not change between calls.

#### Scenario: A full page includes a continuation cursor
- **WHEN** more matching transactions exist beyond the requested page size
- **THEN** the response includes a cursor usable to fetch the next page

#### Scenario: Continuing with a cursor resumes after the last returned row
- **WHEN** the caller calls `list_transactions` again with the cursor from a
  previous response
- **THEN** the results start immediately after the last row the previous call
  returned, with no duplicate or skipped row

#### Scenario: The last page has no continuation cursor
- **WHEN** a page's results reach the end of the caller's matching
  transactions
- **THEN** the response includes no cursor

#### Scenario: An invalid or tampered cursor is rejected
- **WHEN** the caller supplies a cursor that was not returned by a previous
  `list_transactions` call for this tool
- **THEN** the call is rejected rather than returning an arbitrary or
  unscoped page

### Requirement: An unresolved caller identity yields no data
If a `list_accounts` or `list_transactions` call cannot resolve the caller's
Cognito `sub` (no authenticated identity attached to the request), the tool
SHALL return an empty result rather than unscoped data from every owner.

#### Scenario: A request with no resolvable sub returns nothing
- **WHEN** `list_accounts` or `list_transactions` is invoked without a
  resolvable caller `sub`
- **THEN** the result is empty, and no row owned by any user is returned

### Requirement: Both tools are read-only
Neither `list_accounts` nor `list_transactions` SHALL create, modify, or
delete any row.

#### Scenario: Calling either tool leaves data unchanged
- **WHEN** `list_accounts` or `list_transactions` is called with any input
- **THEN** no `accounts`, `transactions`, or `share_grants` row is created,
  modified, or deleted as a result
