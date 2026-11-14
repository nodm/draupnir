# user-authentication Specification

## Purpose

Establishes the single identity source for Draupnir — a Cognito User Pool
federated with Google — and guarantees that every request reaching an
authenticated handler (the MCP endpoint) carries a verified, non-forgeable
identity, and that a token issued to one app client opens no other client's
API.

## Requirements

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

### Requirement: Every ingestion API method has a default throttle
The `ingestion` REST API stage SHALL apply a default throttle of 5 requests per
second with a burst of 10 to every method, sized for its two users. The limit
SHALL apply to each method separately. A request over the limit SHALL be answered
`429` by API Gateway before the Cognito authorizer or any handler runs.

#### Scenario: Normal use stays under the limit
- **WHEN** a signed-in user calls `whoami`, creates an account and requests a few
  upload URLs in a row
- **THEN** no request is throttled

#### Scenario: A flood is throttled before authorization
- **WHEN** requests to an ingestion route, with or without a token, arrive faster
  than 5 per second beyond a burst of 10
- **THEN** the excess requests are answered `429` and no handler runs for them
