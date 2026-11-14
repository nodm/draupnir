## ADDED Requirements

### Requirement: A waiting file is kept in the ingestion queue for 14 days
The ingestion queue SHALL keep each uploaded file's message for 14 days, counted from its enqueue time, before the message expires unprocessed. A backlog shorter than that SHALL NOT lose any upload.

#### Scenario: Backlog longer than the SQS default
- **WHEN** an uploaded file's message has waited in the ingestion queue for 6 days because processing was backed up, and processing then resumes
- **THEN** the file is processed and its outcome is recorded and reported like any other file
