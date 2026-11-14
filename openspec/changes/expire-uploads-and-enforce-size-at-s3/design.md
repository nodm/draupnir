## Context

See proposal.md (Why) for the motivation. The current state:

- `infra/lib/ingestionPipeline.ts` creates the `uploads` bucket with no arguments, so it has
  no lifecycle rules and no versioning.
  - The bucket notifies the `ingestion` queue on `s3:ObjectCreated:*`.
  - `ingestion-dlq` has no `messageRetentionSeconds`, so it uses the SQS default of 4 days.
- `ingestion/src/lib/presignedUpload.ts` presigns a `PutObjectCommand` with
  `ContentType: 'text/csv'` and `IfNoneMatch: '*'`, valid for 900 s.
  - The handler returns `201 { url, key, headers: { 'If-None-Match': '*' } }`.
- `processStatementFile` checks the size twice: once from the S3 event's `object.size`, and
  again from `GetObject`'s `ContentLength` before it buffers the body. Both checks use
  `MAX_UPLOAD_SIZE_BYTES` (10 MiB).
  - The bot keeps its own copy of the limit, `MAX_STATEMENT_BYTES` (10 MiB), in
    `bot/src/lib/upload/files.ts`.
  - The bot writes under `uploads/` with its own `PutObject` and `If-None-Match: *`.

### Does anything read an upload object after ingestion has finished?

No. Each candidate reader was checked:

| Candidate | Reads the S3 object? | Evidence |
| --- | --- | --- |
| `rebuild-account` | No | Its role has Data API statements only, and the code comment says "it reads raw rows from the database, never S3". It rebuilds from `raw_rows`. |
| `backfillAccountBalances` | No | No S3 client. It works from `raw_rows`. |
| Duplicate-file detection | No | The SHA-256 is computed once from the bytes at ingest time and stored in `statement_files.sha256`. Later uploads are compared against `statement_files_approved_sha256_idx`. |
| Redelivery of a committed upload | No | `findRecordedOutcome` and `findOutcomeInOutbox` look up `s3_key` in the database before `GetObject`, and return without touching S3. |
| Reprocessing from the DLQ | **Yes, but only for unrecorded failures** | A dead-lettered file has no `statement_files` row, so a redrive runs `GetObject`. The message can only be redriven while it exists, which is up to DLQ retention after the original enqueue. For a standard queue, expiry counts from the original enqueue time and does not reset on the move to the DLQ. |
| Telegram bot | No | The bot role has no `s3:GetObject` (`infra/src/bot.spec.ts`). The bot reads outcomes from the outcome queue and the database. Its retried writes go to a deterministic key within Telegram's ~24 h retry window, and a pending upload lives 1 h. |
| MCP server | No | No S3 permissions. |
| `infra/scripts/reset-data.sh` | Deletes objects, does not depend on them | Unaffected. |
| Docs | Claim only | ADR-0008 says "Original CSV stays in S3, unchanged (byte-exact source)" and "`jsonb` does not preserve key order (the S3 object does)". `docs/architecture.md` shows "S3 uploads bucket, unchanged". Nothing in code relies on these claims. |

**Conclusion:**

- The only real constraint is that an object must outlive its dead-letter message.
  - Today that is 4 days. After decision 3 it is 14 days.
  - The proposed 30-day default leaves more than two weeks of margin for an investigation that
    starts late.
  - The validator enforces a floor above DLQ retention (decision 1).
- Losing the object loses only two things, both of which nothing consumes:
  - the byte-exact copy of the file;
  - the column order of the original header (`raw_rows` keeps header → value as `jsonb`).

  ADR-0008 is amended to say so (decision 7).

## Goals / Non-Goals

**Goals:**

- Bounded retention for every object under `uploads/`, from both upload paths, set from one
  config value.
- S3 refuses an oversized or empty upload from the API path before anything is stored.
- One size constant shared by the presign policy, the worker and the bot.
- Tests that fail if the size condition or the lifecycle rules disappear.

**Non-Goals:**

- Encryption, Object Lock, replication or versioning changes on the uploads bucket. The
  noncurrent-version rule only covers the case where versioning is enabled one day.
- Size enforcement for the bot path. It already refuses files over 10 MiB before its
  `PutObject`, and the worker re-checks.
- Restoring overwrite protection for a replayed POST (decision 5).
- A compatibility period that serves both the PUT and POST response shapes (decision 6).

## Decisions

### 1. `draupnir-infra:uploadRetentionDays`, default 30, validated with a floor above DLQ retention

Add a new module, `infra/lib/uploadRetention.ts`. It follows the pattern of `logRetention.ts`:

- It exports `UPLOAD_RETENTION_CONFIG_KEY`, `DEFAULT_UPLOAD_RETENTION_DAYS = 30` and
  `uploadRetentionDays(value: string | undefined): number`.
- It returns the default when the key is unset or blank.
- It accepts any whole number of days greater than `INGESTION_DLQ_RETENTION_DAYS` (14).
- For anything else it throws a message that names the key and the floor. `pulumi preview`
  then fails before `up`.

S3 allows any positive day count, so unlike log retention there is no fixed list of values.

Alternatives considered:

- **A hard-coded 30.** This is the same reasoning as log retention: the owner may want longer
  while debugging a new bank format, without a code change.
- **A floor of 1.** That allows a value that silently breaks DLQ reprocessing, which the
  `statement-ingestion-pipeline` spec requires.

### 2. One `aws.s3.BucketLifecycleConfiguration` with two rules

The rules on the `uploads` bucket:

- **`expire-uploads`**:
  - `filter: { prefix: 'uploads/' }`
  - `expiration: { days: N }`
  - `noncurrentVersionExpiration: { noncurrentDays: 1 }`
  - `status: 'Enabled'`
- **`abort-incomplete-multipart-uploads`**:
  - an empty filter, so the rule applies to the whole bucket
  - `abortIncompleteMultipartUpload: { daysAfterInitiation: 1 }`
  - `status: 'Enabled'`

Reasons for this shape:

- `aws.s3.BucketLifecycleConfiguration` is the current resource in `@pulumi/aws` 7.x. The
  `lifecycleRules` input on `aws.s3.Bucket` is deprecated, and the `…V2` name is an alias.
- Neither upload path uses multipart today. Presigned POST is a single request, and the bot
  calls `PutObject`. The abort rule is hygiene, so it covers the whole bucket rather than only
  `uploads/`: abandoned parts cost money wherever they are.
- The noncurrent rule does nothing while versioning is off. It is set now so that turning
  versioning on later does not quietly make retention unbounded: under versioning, the
  `expiration` action only adds a delete marker.
- Lifecycle deletions emit `s3:LifecycleExpiration:*` events, not `s3:ObjectCreated:*`, so
  they never reach the ingestion queue.

Alternatives considered:

- **A single rule that also carries the abort action.** It works, but it would limit the abort
  to `uploads/`.
- **Inline `lifecycleRules` on the bucket.** Deprecated.

### 3. Explicit 14-day retention on `ingestion-dlq`

Set `messageRetentionSeconds: INGESTION_DLQ_RETENTION_DAYS * 86400` with
`INGESTION_DLQ_RETENTION_DAYS = 14`, the SQS maximum, and export the constant for the
validator in decision 1.

Reasons:

- The coupling between DLQ retention and upload retention becomes explicit, in code and in a
  test.
- The window in which a failure can be investigated grows from 4 to 14 days.
- The cost is nil at this volume.

`botQueues.ts` already sets an explicit DLQ retention, so this follows an existing pattern.

### 4. Presigned POST with a signed size policy; response `{ url, fields }`

`createPresignedUpload` calls `createPresignedPost(s3Client, { … })` from
`@aws-sdk/s3-presigned-post` with:

- `Bucket` and `Key`, as today. The SDK adds exact-match `bucket` and `key` conditions.
- `Fields: { 'Content-Type': 'text/csv' }`
- `Conditions`:
  - `['content-length-range', 1, MAX_STATEMENT_BYTES]`
  - `['eq', '$Content-Type', 'text/csv']`
- `Expires: 900`

It returns `{ url, fields }`, and the handler returns that object with `201`.

- `key` and `headers` are dropped from the response: `fields.key` carries the key, and POST
  has no signed headers.
- The handler, routes, auth and error mapping are unchanged.
- IAM is unchanged, because S3 authorizes a POST policy as `s3:PutObject`.

**Test approach.** The unit test does not mock the presigner. It calls the real
`createPresignedPost` with an `S3Client` built with static fake credentials and a fixed region,
which needs no network. It then base64-decodes `fields.Policy` and asserts on the conditions:

- `content-length-range` is `[1, 10485760]`;
- the key condition is exact;
- `Content-Type` must equal `text/csv`;
- the expiration is about 15 minutes ahead.

This tests what S3 will enforce, not the arguments passed to a mock.

Alternatives considered:

- **Keep the PUT and add a `Content-Length` signed header.** SigV4 can sign `content-length`,
  but that fixes the exact size at issue time, so the client would have to declare the size
  first. That is a worse contract, and S3 still has no range.
- **Mock `createPresignedPost`** as the current test mocks `getSignedUrl`. Rejected: it cannot
  catch a policy that the SDK builds differently from what was intended.

### 5. Losing `If-None-Match` on the API path is accepted

S3 POST Object does not support conditional writes. They apply to `PutObject` and
`CompleteMultipartUpload`. So within the 15-minute policy window, a holder of the form can POST
twice to the same key, and the second POST overwrites the first instead of getting `412`.

What happens then:

- Both writes emit `ObjectCreated`.
- The worker processes whatever the object contains when its `GetObject` runs.
- `statement_files.s3_key` is unique, so the second event returns the recorded outcome
  (`findRecordedOutcome`).

The result is still exactly one outcome per key. The worst case: the first content's outcome
is recorded, and the overwriting bytes are never ingested.

Only the authenticated owner who requested the form can do this, and only to their own fresh
key. Re-uploading is the documented recovery anyway, and a new request gets a new key. This is
acceptable at two users.

Alternatives considered:

- **A bucket policy requiring `s3:if-none-match`.** It cannot be satisfied by a POST, so it
  would block every API upload.
- **Versioning plus processing by version id.** A data-model change for a self-inflicted edge
  case.

The bot path keeps its `If-None-Match`, where it matters because Telegram retries.

### 6. Hard cutover, no dual-format period

The endpoint switches to the new shape in one deploy.

- No client in this repo calls it. The bot is the everyday path, and it writes to S3 directly.
- ADR-0009 says manual uploads were done "through presigned URLs by hand", so the only
  plausible consumers are the owner's personal scripts or shell history outside this repo.
- **Implementation is gated on the owner confirming whether such consumers exist** (task 1.1).
- If they do, the owner updates them in step with the deploy. A `?format=put` escape hatch is
  possible, but it would keep the unbounded path alive, which defeats the change.

`ingestion/README.md` gets a short "Upload a statement by hand" section with the `curl -F`
form, so the new contract is written down somewhere besides the spec.

### 7. A single size constant in `shared`; docs amended rather than rewritten

`shared` exports `MAX_STATEMENT_BYTES = 10 * 1024 * 1024`.

- `presignedUpload.ts` (the policy), `processStatementFile.ts` (both checks) and
  `bot/src/lib/upload/files.ts` import it, replacing their local copies.
- Both projects already depend on `shared`, so module boundaries are unaffected.
- The worker's comment ("a presigned PUT URL can't itself carry a size limit") is rewritten:
  the check is now defence in depth for the bot path and any other writer.

Docs:

- **ADR-0008** gets a dated "Amendment (2026-11)" note under Decision. Layer 1 becomes:
  "Original CSV kept in S3 for `uploadRetentionDays` (default 30) for inspection and DLQ
  reprocessing. Raw rows are the durable lossless record, apart from header column order." The
  original text is kept, as ADRs are records.
- **`docs/architecture.md`**: change the "presigns a PutObject URL" edge to "presigns a POST
  policy (≤ 10 MiB)", and the CSV node to "S3 uploads bucket, expires after 30 days".
- **ADR-0004** is left as is. It records a decision at its time, and its PUT detail is
  superseded by this change's specs.

## Risks / Trade-offs

- **[Existing objects older than 30 days are deleted shortly after deploy, irreversibly]** →
  The migration plan has an optional `aws s3 sync` backup step before deploy. Nothing in the
  system needs those objects.
- **[An out-of-repo script still sends a PUT with the old response fields]** → It fails right
  away: the response no longer has `headers`, and a PUT to the POST URL is refused. Nothing
  fails silently. Task 1.1 confirms consumers before implementation starts.
- **[A browser or `fetch` client builds the form wrongly, for example with the file field not
  last or `Content-Type` missing]** → S3 answers `400` with a specific error code. The README
  example shows the correct order.
- **[Byte-exact source and header column order are lost after expiry]** → Accepted and
  recorded in ADR-0008. No reader exists. If one is ever needed, raise retention through
  config.
- **[S3 lifecycle runs asynchronously, so objects can live a day or so past N]** → Fine for a
  retention bound. The spec says "older than", not "at exactly".
- **[The overwrite race on a replayed POST (decision 5)]** → Self-inflicted only, and still
  one outcome per key.

## Migration Plan

1. The owner confirms whether any out-of-repo client uses `POST /uploads` (task 1.1), and
   updates any such client to the POST form.
2. Optional: back up the bucket first with
   `aws s3 sync s3://<uploadsBucketName> <local-dir>`.
3. Run `pnpm nx run infra:up` (or the usual deploy). In one `pulumi up`, the lifecycle
   configuration, the DLQ retention and the new ingestion bundle deploy together.
4. Verify:
   - `aws s3api get-bucket-lifecycle-configuration` shows both rules;
   - a hand upload with the README `curl` example succeeds and produces an outcome;
   - an 11 MiB file gets `EntityTooLarge` and no object.

**Rollback:** revert the commit and `pulumi up`. This removes the lifecycle configuration and
restores the PUT presigner. Objects that were already expired cannot be restored, except from
the optional backup.

## Open Questions

- ~~Does S3 POST Object accept a conditional-write field?~~ Resolved on 2026-11-14 against the
  real bucket: a second POST with the same form returns `204` and overwrites the object. The
  worker returned the recorded outcome for the second event, as decision 5 expects.
