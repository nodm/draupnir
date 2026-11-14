# statement-csv-upload Specification

## Purpose

Lets an authenticated user upload a bank statement CSV without routing the file bytes
through a Lambda, by issuing a presigned S3 POST scoped to that user and the account
they selected, with the size limit enforced by S3 itself.

## Requirements

### Requirement: Presigned upload URL is scoped to the caller's identity and a selected account
The system SHALL issue a presigned S3 POST: a target `url` plus the form `fields`
the client sends with the file. Its signed policy SHALL allow exactly one object key,
`uploads/{sub}/{accountId}/{uuid}.csv`, where `sub` is taken only from the
authenticated caller's identity and `accountId` identifies an existing account
the caller is an `owner` member of. The response body SHALL be
`{ "url": string, "fields": { [name]: string } }`, and `fields.key` SHALL be the
object key. The system SHALL NOT accept a caller-supplied `sub` or user id
anywhere in the request, and SHALL reject a request naming an account that does
not exist or of which the caller is not an `owner` member.

The signed policy SHALL also:
- require `Content-Type` to be exactly `text/csv`;
- limit the file size to between 1 byte and 10 MiB (10 485 760 bytes) inclusive;
- expire 15 minutes after it is issued.

S3 SHALL reject any upload that breaks one of these conditions, and no object
SHALL be created for it.

#### Scenario: Authenticated request for the caller's own account succeeds
- **WHEN** an authenticated user requests an upload URL naming an `accountId`
  they are an `owner` member of
- **THEN** the response contains a presigned POST `url` and `fields`, whose
  `fields.key` is `uploads/{their sub}/{that accountId}/{uuid}.csv`

#### Scenario: Signed policy carries the size limit
- **WHEN** a presigned POST is issued
- **THEN** its policy contains a `content-length-range` condition of 1 to
  10 485 760 bytes, an exact-match condition on the key, an exact-match
  `Content-Type` of `text/csv`, and an expiration 15 minutes after issue

#### Scenario: Upload to a different key is rejected by S3
- **WHEN** a client submits the signed form with its `key` field changed
- **THEN** S3 rejects the request and no object is created

#### Scenario: Request naming an account the caller only views is rejected
- **WHEN** an authenticated user requests an upload URL naming an `accountId`
  they are only a `viewer` member of
- **THEN** the request is rejected before any presigned POST is issued

#### Scenario: Request naming another user's account is rejected
- **WHEN** an authenticated user requests an upload URL naming an `accountId`
  they are not a member of
- **THEN** the request is rejected before any presigned POST is issued

#### Scenario: Request naming a nonexistent account is rejected
- **WHEN** an authenticated user requests an upload URL naming an `accountId`
  that does not exist
- **THEN** the request is rejected before any presigned POST is issued

#### Scenario: Unauthenticated request is rejected
- **WHEN** a request for an upload URL carries no valid Cognito token
- **THEN** the request is rejected and no presigned POST is issued

### Requirement: Uploaded file triggers ingestion without further app involvement
Once the client completes the POST of the signed form to the presigned `url`,
the resulting S3 object SHALL trigger the statement ingestion pipeline (see
`statement-ingestion-pipeline`) without any further call from the app's API.

#### Scenario: POST to presigned URL is picked up automatically
- **WHEN** a client successfully POSTs a CSV file with the issued `fields` to the
  presigned `url`
- **THEN** the file is picked up by the ingestion pipeline without the client making
  any additional API call

### Requirement: Oversized and empty uploads are refused before they are stored
A file larger than 10 MiB, or an empty file, sent with an issued presigned POST
SHALL be refused by S3 at upload time. No object SHALL be stored, and no
ingestion SHALL be triggered.

#### Scenario: Oversized file is refused at upload
- **WHEN** a client POSTs an 11 MiB file with valid issued `fields`
- **THEN** S3 responds with an error (`EntityTooLarge`), no object exists at
  `fields.key`, and no ingestion message is produced

#### Scenario: Empty file is refused at upload
- **WHEN** a client POSTs a 0-byte file with valid issued `fields`
- **THEN** S3 responds with an error (`EntityTooSmall`) and no object exists at
  `fields.key`

#### Scenario: File at the limit is accepted
- **WHEN** a client POSTs a file of exactly 10 485 760 bytes with valid issued
  `fields`
- **THEN** S3 stores the object and ingestion is triggered

### Requirement: The ingestion worker re-checks the size limit
Regardless of how an object came to exist under `uploads/` (presigned POST, the
Telegram bot, or any other writer), the ingestion worker SHALL refuse to process
an object larger than 10 MiB without reading its body into memory. The
presigned POST policy, the worker and the bot SHALL use the same limit.

#### Scenario: Oversized object written outside the presigned POST
- **WHEN** an object larger than 10 MiB appears under `uploads/` through a
  path other than the presigned POST
- **THEN** the worker refuses it on size before buffering its body, and no
  `statement_files`, `raw_rows` or `transactions` rows are written for it
