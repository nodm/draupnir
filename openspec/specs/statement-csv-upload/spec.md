# statement-csv-upload Specification

## Purpose

Defines how an uploaded bank statement CSV enters the system: the Telegram bot stores
it under `uploads/` in the uploads bucket, which starts ingestion with no further
call, and the ingestion worker re-checks every object's size, whoever wrote it.

## Requirements

### Requirement: A stored upload triggers ingestion without further calls
Once a statement file is stored under `uploads/` in the uploads bucket, the resulting S3 object SHALL trigger the statement ingestion pipeline (see `statement-ingestion-pipeline`) without any further call from the writer. The Telegram bot (see `telegram-statement-upload`) is the only writer of these objects.

#### Scenario: A stored upload is picked up automatically
- **WHEN** the Telegram bot stores a statement file under `uploads/{sub}/{accountId}/`
- **THEN** the file is picked up by the ingestion pipeline without the bot making any further call to start it

### Requirement: The ingestion worker re-checks every upload's size
Regardless of how an object came to exist under `uploads/` (the Telegram bot or any other writer), the ingestion worker SHALL refuse to process an object larger than 10 MiB without reading its body into memory. The worker and the bot SHALL use the same limit.

#### Scenario: Oversized object written outside the bot
- **WHEN** an object larger than 10 MiB appears under `uploads/` through a path other than the Telegram bot
- **THEN** the worker refuses it on size before buffering its body, and no `statement_files`, `raw_rows` or `transactions` rows are written for it
