## ADDED Requirements

### Requirement: A rejection by a non-owner is reported but not recorded
When the uploader is not an `owner` member of the upload-selected account at
processing time (for example, ownership was revoked after the presigned URL was
issued), or the account is not visible to them at all (removed member, or the
account no longer exists, which the database does not distinguish), the pipeline SHALL reject the file with the reason `not-owner` and
SHALL NOT write a `statement_files` row, because the database refuses writes by
non-owners. The message SHALL be acknowledged rather than retried, and nothing
SHALL reach the dead-letter destination. The outcome has no file id.

#### Scenario: Uploader who lost ownership is rejected without a record
- **WHEN** a file is processed for an uploader who is no longer an `owner` of
  the upload-selected account
- **THEN** the outcome is `rejected` with reason `not-owner` and no file id, no
  `statement_files` row exists for the object, and the message is acknowledged
