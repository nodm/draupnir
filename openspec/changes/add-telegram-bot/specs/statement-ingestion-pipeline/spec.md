## ADDED Requirements

### Requirement: Each processed file's outcome is published
After committing a file's outcome, the pipeline SHALL publish a message to an
outcome queue containing:
- the S3 object key and the `statement_files` id;
- the uploader's `sub`;
- the status;
- rejection reasons and warnings;
- for approved files, the number of newly created transactions and the covered
  period.

The message SHALL contain no transaction rows. Publishing SHALL NOT depend on
how the file was uploaded, so any channel can consume it.

#### Scenario: Approved file outcome is published
- **WHEN** a file is approved
- **THEN** an outcome message with status `approved`, its new-transaction count,
  and covered period is published for that object key

#### Scenario: Rejected file outcome is published
- **WHEN** a file is rejected
- **THEN** an outcome message with status `rejected` and all its reasons is
  published for that object key

#### Scenario: Outcome is published only after commit
- **WHEN** the database transaction for a file fails and is rolled back
- **THEN** no outcome message is published for that attempt
