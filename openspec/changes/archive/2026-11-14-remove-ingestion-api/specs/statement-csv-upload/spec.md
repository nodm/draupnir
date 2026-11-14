## ADDED Requirements

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

## REMOVED Requirements

### Requirement: Presigned upload URL is scoped to the caller's identity and a selected account
**Reason**: `POST /uploads` belonged to the ingestion REST API, which is removed. Each signed form could be reused for 15 minutes directly against S3, outside the API's throttle, and nothing calls the route since ADR-0009 made the Telegram bot the only interface.
**Migration**: Send the CSV to the Telegram bot (`telegram-statement-upload`). The bot checks that the user owns the account and writes the object under the same key shape, `uploads/{sub}/{accountId}/…`.

### Requirement: Oversized and empty uploads are refused before they are stored
**Reason**: These limits were conditions of the presigned POST policy, which is removed with `POST /uploads`.
**Migration**: The bot refuses files over 10 MiB before it writes them (`telegram-statement-upload`), and the worker re-checks every object's size ("The ingestion worker re-checks every upload's size").

### Requirement: Uploaded file triggers ingestion without further app involvement
**Reason**: It described an upload completed through the presigned POST form, which is removed.
**Migration**: Replaced by "A stored upload triggers ingestion without further calls", which describes the bot as the writer.

### Requirement: The ingestion worker re-checks the size limit
**Reason**: Its scenario and limit refer to the presigned POST policy, which is removed.
**Migration**: Replaced by "The ingestion worker re-checks every upload's size", which keeps the same worker behavior.
