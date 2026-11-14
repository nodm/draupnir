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

### Requirement: Only the MCP API accepts the user pool's bearer tokens
The MCP API SHALL be the only API of the stack that accepts a bearer token issued by the user pool. It accepts access tokens only. Any other route that receives a user pool token SHALL verify that the token was issued to that route's own app client. For example, the Telegram sign-in callback checks the audience of the ID token it gets from its own code exchange. As a result, a token issued to a client that an MCP client registered SHALL grant no access beyond the MCP tools.

#### Scenario: No other API has a user pool authorizer
- **WHEN** the stack is built
- **THEN** exactly one REST API has a Cognito user pool authorizer, and it is the MCP API

#### Scenario: A registered MCP client's ID token opens nothing
- **WHEN** an ID token issued to a client registered through the MCP registration endpoint is sent to any route of the stack
- **THEN** the route refuses it: the MCP endpoint refuses ID tokens, and no other route accepts tokens issued to that client
