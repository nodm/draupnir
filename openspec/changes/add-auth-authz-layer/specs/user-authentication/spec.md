## Purpose

Establishes the single identity source for Draupnir — a Cognito User Pool
federated with Google — and guarantees every request reaching a handler on
`ingestion`'s authenticated routes carries a verified, non-forgeable
identity. (`mcp`'s authorizer attachment is deferred to a future change —
see `design.md`'s Non-Goals.)

## ADDED Requirements

### Requirement: Sign-up is restricted to an email allowlist

The system SHALL reject federated sign-up for any Google account whose email
is not on a pre-configured allowlist, before a Cognito user profile is
created for it.

#### Scenario: Allowlisted email completes sign-up

- **WHEN** a Google account whose email is on the allowlist completes the
  OAuth sign-in redirect for the first time
- **THEN** a new Cognito user pool profile is created for that identity and
  sign-in succeeds

#### Scenario: Non-allowlisted email is rejected before profile creation

- **WHEN** a Google account whose email is not on the allowlist attempts the
  OAuth sign-in redirect
- **THEN** sign-up is rejected, sign-in fails, and no Cognito user pool
  profile exists for that identity afterward

### Requirement: Federated identities are never linked across accounts

The system SHALL treat each Google account as a fully independent Cognito
identity, with no configuration that consolidates or links separate Google
accounts into one profile.

#### Scenario: Two Google accounts yield two distinct identities

- **WHEN** two different allowlisted Google accounts each complete sign-up
- **THEN** each is assigned its own distinct Cognito profile and its own
  distinct `sub`, with no shared or merged identity between them

### Requirement: API requests require a verified Cognito token

The system SHALL reject, before any handler code runs, any request to an
authenticated route that lacks a valid, unexpired token issued by the
Cognito user pool. A request with a valid token SHALL reach the handler with
the token's `sub` and `email` claims available to it.

#### Scenario: Request without a valid token is rejected

- **WHEN** a request is made to an authenticated route with no token, an
  expired token, or a token not issued by this user pool
- **THEN** the request is rejected before reaching handler code, and no
  handler-level logic executes

#### Scenario: Request with a valid token reaches the handler with claims

- **WHEN** a request is made to an authenticated route with a valid,
  unexpired token issued by this user pool
- **THEN** the handler executes and can read the token's `sub` and `email`
  claims

### Requirement: Authenticated identity is retrievable via a whoami endpoint

The system SHALL expose an authenticated endpoint that returns the caller's
own identity claims, proving the token-to-claims path end-to-end without
depending on any user-owned data resource.

#### Scenario: Authenticated whoami request returns caller identity

- **WHEN** an authenticated user makes a request to the whoami endpoint
- **THEN** the response contains that user's `sub` and `email`, matching the
  claims from their token

#### Scenario: Unauthenticated whoami request is rejected

- **WHEN** a request to the whoami endpoint is made without a valid token
- **THEN** the request is rejected before reaching the whoami handler
