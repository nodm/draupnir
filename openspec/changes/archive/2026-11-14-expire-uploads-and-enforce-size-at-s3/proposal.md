## Why

The `uploads` bucket has no lifecycle rules, so every bank statement ever uploaded stays in
S3 forever. That is financial data kept with no purpose: once a file's outcome is committed,
nothing reads the object again. Separately, the 10 MB upload limit is only enforced by the
ingestion worker after the object is already stored, because a presigned PUT URL cannot carry
a size condition. A caller holding a URL can store an arbitrarily large object that the
pipeline then has to fetch metadata for and reject.

## What Changes

- **Lifecycle policy on the `uploads` bucket**:
  - objects under `uploads/` expire after `draupnir-infra:uploadRetentionDays` days (default
    30);
  - incomplete multipart uploads are aborted after 1 day;
  - noncurrent versions expire after 1 day, so the rule still bounds retention if versioning
    is ever turned on.

  This covers both upload paths: `POST /uploads` and the Telegram bot.
- **Explicit ingestion DLQ retention of 14 days.** Today it is the SQS default of 4 days.
  Upload retention must be longer than DLQ retention, so a dead-lettered file can still be
  reprocessed. The config is validated against that floor.
- **BREAKING: `POST /uploads` returns a presigned POST instead of a presigned PUT.**
  - The response changes from `{ url, key, headers: { "If-None-Match": "*" } }` to
    `{ url, fields }`.
  - The client must send a `multipart/form-data` POST to `url`, with every entry of `fields`
    as form fields followed by the file as the last field, `file`.
  - The object key is still available as `fields.key`.
  - The signed policy pins the exact key and `Content-Type: text/csv`, sets
    `content-length-range` to 1..10 MiB, and expires after 15 minutes, as the URL does today.
  - S3 rejects an empty or oversized file with `400 EntityTooLarge` / `EntityTooSmall`, and
    no object is created.
  - Any client written against the old contract stops working when this deploys. No
    compatibility period is planned (see design.md).
- **Server-side size check stays** in `processStatementFile` as defence in depth. It covers
  the bot's PutObject path and any future writer. The 10 MiB constant moves to `shared`, so
  the presign policy, the worker and the bot use the same number.
- **The overwrite guard on a replayed upload changes shape.** S3 POST Object does not honour
  `If-None-Match`, so a replay of the same signed form within its 15-minute window overwrites
  the object instead of getting `412`. Design.md explains why this is acceptable, and how the
  worker still produces exactly one outcome per key.
- **Docs**: ADR-0008 layer 1 changes from "original CSV stays in S3" to "original CSV is
  kept for a bounded period", with an amendment note. `docs/architecture.md` diagram labels
  are updated.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `statement-csv-upload`:
  - the upload credential becomes a presigned POST with a size-bounded policy, and its
    response shape changes;
  - S3 itself rejects oversized or empty files;
  - the worker's size check remains.
- `statement-raw-storage`: original upload objects are kept for a bounded, configured period.
  Recorded file facts, raw rows, rebuild and duplicate detection do not depend on the object
  still existing.
- `statement-ingestion-pipeline`: a dead-lettered file stays reprocessable for the DLQ's whole
  retention, because upload objects outlive dead-letter messages.

## Impact

- **API contract**: `POST /uploads` response body (`ingestion/src/presignedUpload.ts`,
  `ingestion/src/lib/presignedUpload.ts`).
  - In-repo consumers: unit tests and docs only. There is no web app or script in this repo
    that calls the endpoint, `ingestion/features` does not exercise it, and the bot writes to
    S3 directly.
  - Out-of-repo consumers: ADR-0009 notes that statements were uploaded "through presigned
    URLs by hand", so personal scripts may exist outside this repo. Implementation waits until
    the owner confirms whether such consumers exist.
- **Dependencies**:
  - add `@aws-sdk/s3-presigned-post` to `ingestion`, pinned to the same AWS SDK release as
    the other `@aws-sdk/*` packages;
  - `@aws-sdk/s3-request-presigner` is removed from `ingestion` if nothing else uses it.
- **Infra**:
  - `infra/lib/ingestionPipeline.ts`: a new `aws.s3.BucketLifecycleConfiguration` and an
    explicit `messageRetentionSeconds` on `ingestion-dlq`;
  - a new config key `draupnir-infra:uploadRetentionDays`;
  - new guardrail tests in `infra/src`.
- **Data**: after deploy, S3 deletes existing objects older than the retention period, within
  a day or two. Database records keep their `s3_key` and `sha256`. A key can then point to an
  object that no longer exists, which is expected.
- **IAM**: unchanged. A presigned POST is authorized as `s3:PutObject`, which the
  presigned-upload role already has.
