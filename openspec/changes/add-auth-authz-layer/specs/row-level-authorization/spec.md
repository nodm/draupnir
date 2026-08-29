## Purpose

Establishes the ownership and sharing model every user-owned table must
follow — each row belongs to exactly one user, visibility can be extended to
another user per-resource, and access is re-evaluated on every request
rather than cached.

## ADDED Requirements

### Requirement: Every user-owned resource has exactly one owner
Every table storing user-owned data SHALL record the owning user's identity
on each row, and that ownership SHALL be assignable to exactly one user at a
time.

#### Scenario: A resource's owner is recorded at creation
- **WHEN** a user-owned resource is created
- **THEN** the resource's row records that user as its sole owner

### Requirement: Access to a resource is granted per-resource, not per-user
The system SHALL allow a resource's owner to grant another specific user
visibility into that specific resource, without granting visibility into any
of the owner's other resources.

#### Scenario: A grant covers only the named resource
- **WHEN** a resource's owner grants another user access to that one
  resource
- **THEN** the grantee can access that specific resource, and cannot access
  any other resource owned by the same owner that was not separately granted

### Requirement: Only a resource's owner may grant or revoke access to it
The system SHALL reject any attempt to create or delete a share grant for a
resource made by a user other than that resource's owner.

#### Scenario: Owner creates a grant
- **WHEN** a resource's owner creates a share grant naming another user as
  grantee
- **THEN** the grant is created

#### Scenario: Non-owner is rejected from creating a grant
- **WHEN** a user who is not a resource's owner attempts to create a share
  grant for that resource
- **THEN** the attempt is rejected and no grant is created

### Requirement: Revoking access takes effect on the very next request
The system SHALL re-evaluate ownership and grant state on every request; a
revoked grant SHALL NOT continue to authorize access on any request made
after the revocation completes.

#### Scenario: Revoked grant no longer authorizes access
- **WHEN** a share grant is deleted, and the former grantee then makes a
  request for the previously shared resource
- **THEN** that request is denied access to the resource

### Requirement: A user always retains access to what they own
The system SHALL allow a resource's owner to access that resource
regardless of any grant state, since ownership itself is sufficient for
access.

#### Scenario: Owner accesses own resource with no grants involved
- **WHEN** a resource's owner requests that resource and no share grants
  exist for it
- **THEN** the request succeeds
