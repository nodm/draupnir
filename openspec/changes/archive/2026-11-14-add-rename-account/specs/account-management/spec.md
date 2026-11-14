## ADDED Requirements

### Requirement: An owner can rename an account
The system SHALL let an `owner` member of an account change its display name. The new
name SHALL be non-empty after trimming and at most 60 characters. The caller's identity
SHALL come only from their authenticated identity. No other account field SHALL change.
The name is the account's, so every member sees the new name.

#### Scenario: Owner renames an account
- **WHEN** an owner renames an account to "Salary"
- **THEN** the account's display name is "Salary" and all other fields are unchanged

#### Scenario: Viewer cannot rename
- **WHEN** a `viewer` member or non-member tries to rename an account
- **THEN** the request is rejected and the display name is unchanged

#### Scenario: Invalid name is rejected
- **WHEN** an owner submits an empty, whitespace-only or over-60-character name
- **THEN** the request is rejected and the display name is unchanged
