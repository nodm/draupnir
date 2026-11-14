## ADDED Requirements

### Requirement: Original upload objects are kept for a bounded period
The system SHALL delete every object under `uploads/` in the uploads bucket
once it is older than the configured upload retention. The retention SHALL be
read from the Pulumi config key `draupnir-infra:uploadRetentionDays`, and SHALL
default to 30 days when the key is not set.

The system SHALL also:
- abort incomplete multipart uploads to the bucket 1 day after they start;
- delete a noncurrent object version 1 day after it becomes noncurrent, if the
  bucket ever has versioning enabled.

The retention SHALL be longer than the ingestion dead-letter retention (see
`statement-ingestion-pipeline`). A value that is not a whole number of days
greater than that SHALL fail `pulumi preview` and `pulumi up` before any
resource changes, with an error that names the config key.

#### Scenario: Default retention
- **WHEN** the stack is deployed without `draupnir-infra:uploadRetentionDays`
  set
- **THEN** the uploads bucket has a lifecycle rule, filtered to the `uploads/`
  prefix, that expires objects after 30 days

#### Scenario: Configured retention
- **WHEN** `draupnir-infra:uploadRetentionDays` is set to 60 and the stack is
  deployed
- **THEN** the `uploads/` lifecycle rule expires objects after 60 days

#### Scenario: Retention not longer than DLQ retention is refused
- **WHEN** `draupnir-infra:uploadRetentionDays` is set to `7`, `0`, `-1`, `abc`
  or `30.5`
- **THEN** the preview fails with an error that names
  `draupnir-infra:uploadRetentionDays`, and nothing is deployed

#### Scenario: Abandoned multipart upload is cleaned up
- **WHEN** a multipart upload to the uploads bucket is started and never
  completed
- **THEN** S3 aborts it, and its stored parts are deleted, 1 day after it was
  started

#### Scenario: Noncurrent versions are bounded
- **WHEN** versioning is enabled on the uploads bucket and an object under
  `uploads/` expires
- **THEN** the version that the expiration makes noncurrent is permanently
  deleted 1 day later

### Requirement: Recorded imports do not depend on the original object
File-level records, per-account records, raw rows, rebuilds, duplicate-file
detection and redelivery handling SHALL work the same whether or not the
original upload object still exists. A file-level record SHALL keep its S3
object key and SHA-256 after the object has expired.

#### Scenario: Rebuild after the object expired
- **WHEN** the rebuild operation runs for an account whose files' upload
  objects have all expired
- **THEN** the account's transactions are rebuilt from its stored raw rows,
  with the same result as before the objects expired

#### Scenario: Duplicate detection after the object expired
- **WHEN** a file is uploaded for an account, and a file with the same SHA-256
  was approved for that account and its object has since expired
- **THEN** the new upload is rejected with the "duplicate of an earlier import"
  reason

#### Scenario: Redelivery after the object expired
- **WHEN** a queue message for an object whose outcome was already committed is
  delivered after that object has expired
- **THEN** the recorded outcome is returned, and no error or new record results
