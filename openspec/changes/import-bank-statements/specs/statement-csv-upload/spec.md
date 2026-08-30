## Purpose

Lets an authenticated user upload a bank statement CSV without routing the file bytes
through a Lambda, by issuing a presigned S3 PUT URL scoped to that user and the bank
they selected.

## ADDED Requirements

### Requirement: Presigned upload URL is scoped to the caller's identity and a selected account
The system SHALL issue a presigned S3 PUT URL whose object key is
`uploads/{sub}/{accountId}/{uuid}.csv`, where `sub` is taken only from the
authenticated caller's Cognito claim and `accountId` identifies an existing
`accounts` row owned by that same caller. The system SHALL NOT accept a
caller-supplied `sub` or user id anywhere in the request, and SHALL reject a request
naming an account that does not exist or is not owned by the caller.

#### Scenario: Authenticated request for the caller's own account succeeds
- **WHEN** an authenticated user requests an upload URL naming an `accountId` they
  own
- **THEN** the response contains a presigned PUT URL whose key is
  `uploads/{their sub}/{that accountId}/{uuid}.csv`

#### Scenario: Request naming another user's account is rejected
- **WHEN** an authenticated user requests an upload URL naming an `accountId` owned
  by a different user
- **THEN** the request is rejected before any presigned URL is issued

#### Scenario: Request naming a nonexistent account is rejected
- **WHEN** an authenticated user requests an upload URL naming an `accountId` that
  does not exist
- **THEN** the request is rejected before any presigned URL is issued

#### Scenario: Unauthenticated request is rejected
- **WHEN** a request for an upload URL carries no valid Cognito token
- **THEN** the request is rejected and no presigned URL is issued

### Requirement: Uploaded object triggers ingestion without further app involvement
Once the client completes the PUT to the presigned URL, the resulting S3 object SHALL
trigger the statement ingestion pipeline (see `statement-ingestion-pipeline`) without
any further call from the app's API.

#### Scenario: PUT to presigned URL is picked up automatically
- **WHEN** a client successfully PUTs a CSV file to a presigned URL issued by this
  capability
- **THEN** the file is picked up by the ingestion pipeline without the client making
  any additional API call
