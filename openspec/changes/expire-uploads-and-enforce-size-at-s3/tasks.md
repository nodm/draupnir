## 1. Gate

- [x] 1.1 Ask the owner whether anything outside this repo calls `POST /uploads` and depends on the `{ url, key, headers }` response, such as personal scripts or shell aliases. Do not start group 3 until they answer. If such consumers exist, record in the PR description how and when they will be switched to the POST form. Verify: the answer is recorded in the PR description.

  - Answered 2026-11-14: there are no consumers outside this repo, so the switch happens at deploy.

## 2. Shared size limit

- [x] 2.1 Add `shared/src/lib/statementLimits.ts`, exporting `MAX_STATEMENT_BYTES = 10 * 1024 * 1024`, and re-export it from `shared/src/index.ts`. Replace the local constant in `bot/src/lib/upload/files.ts`, keeping its existing importers working, and `MAX_UPLOAD_SIZE_BYTES` in `ingestion/src/lib/processStatementFile.ts`. Rewrite the worker's comment to describe the check as defence in depth for the bot and any other writer, not as a substitute for the presigned PUT. Verify with `pnpm nx run-many -t test,lint,typecheck -p shared bot ingestion`. Also check that `grep -rn "10 \* 1024 \* 1024" bot ingestion shared --include=*.ts` matches only `statementLimits.ts`.

  - Result: the grep also matches three `10 * 1024 * 1024 + 1` fixtures in `bot/src/lib/upload/upload.spec.ts`. Those are test inputs, not limits, so they stay.

## 3. Presigned POST

- [x] 3.1 Add `@aws-sdk/s3-presigned-post` to `ingestion/package.json`, pinned to the same version as the other `@aws-sdk/*` packages (currently `3.1121.0`), and run `pnpm install`. Verify that `pnpm-lock.yaml` resolves it and that `pnpm nx run ingestion:build` succeeds.
- [x] 3.2 Rewrite `createPresignedUpload` in `ingestion/src/lib/presignedUpload.ts` to use `createPresignedPost` with:
  - `Key`: the same `uploads/{sub}/{accountId}/{uuid}.csv` key as today;
  - `Fields: { 'Content-Type': 'text/csv' }`;
  - `Conditions`: `['content-length-range', 1, MAX_STATEMENT_BYTES]` and `['eq', '$Content-Type', 'text/csv']`;
  - `Expires: 900`.

  Change `PresignedUpload` to `{ url: string; fields: Record<string, string> }`, and replace the `IfNoneMatch` comment with a short note pointing to design.md decision 5. The membership check is unchanged. Verify with `pnpm nx run ingestion:typecheck`.
- [x] 3.3 Rewrite `ingestion/src/lib/presignedUpload.spec.ts` to stop mocking the presigner. Use a real `S3Client({ region: 'eu-north-1', credentials: { accessKeyId: 'AKIDTEST', secretAccessKey: 'secret' } })`, then decode `fields.Policy` (base64 JSON) and assert:
  - a condition `['content-length-range', 1, 10485760]`;
  - `{ key }` equals `fields.key`, which matches `^uploads/user-123/acc-1/[0-9a-f-]+\.csv$`;
  - an exact `Content-Type` condition `text/csv`, with `fields['Content-Type'] === 'text/csv'`;
  - `{ bucket: 'draupnir-uploads' }`;
  - an `expiration` 15 minutes ±1 min from now;
  - no `headers` or top-level `key` in the result.

  Keep the four rejection tests (no sub, viewer, non-member, nonexistent), and make each assert that no form was returned. Verify with `pnpm nx run ingestion:test`. Then temporarily remove the `content-length-range` condition and confirm the test fails before restoring it.
- [x] 3.4 Remove `@aws-sdk/s3-request-presigner` from `ingestion/package.json` if `grep -rn "s3-request-presigner" --include=*.ts . | grep -v node_modules` is empty after 3.2–3.3. Verify with `pnpm install` and `pnpm nx run ingestion:build`.
- [x] 3.5 Check that the handler `ingestion/src/presignedUpload.ts` still returns `201` with the new body, and update its imports or types if needed. Search for any other consumers with `grep -rn "If-None-Match\|presign\|headers\[" ingestion/features ingestion/src docs infra/scripts`. The only expected hits are the bot's own `PutObject` and the docs handled in group 5. Verify with `pnpm nx run-many -t test,lint -p ingestion`.

## 4. Infra: lifecycle and DLQ retention

- [x] 4.1 Add `infra/lib/uploadRetention.ts` with:
  - `UPLOAD_RETENTION_CONFIG_KEY = 'draupnir-infra:uploadRetentionDays'`;
  - `DEFAULT_UPLOAD_RETENTION_DAYS = 30`;
  - `INGESTION_DLQ_RETENTION_DAYS = 14`;
  - `uploadRetentionDays(value)`: blank or undefined → 30; any whole number greater than 14 → that number; anything else throws naming the key and the floor.

  Add `infra/src/uploadRetention.spec.ts` covering:
  - `undefined` and `''` → 30;
  - `'60'` and `' 15 '` → the number;
  - `'14'`, `'7'`, `'0'`, `'-1'`, `'abc'` and `'30.5'` throw `/draupnir-infra:uploadRetentionDays/`.

  Verify with `pnpm nx run infra:test`.
- [x] 4.2 In `infra/lib/ingestionPipeline.ts`:
  - give `ingestion-dlq` the setting `messageRetentionSeconds: INGESTION_DLQ_RETENTION_DAYS * 24 * 60 * 60`;
  - add `aws.s3.BucketLifecycleConfiguration('uploads', …)` on `uploadsBucket.id` with two rules:
    - `expire-uploads`: prefix `uploads/`, `expiration.days` from `uploadRetentionDays(new pulumi.Config().get('uploadRetentionDays'))`, and `noncurrentVersionExpiration.noncurrentDays: 1`;
    - `abort-incomplete-multipart-uploads`: an empty filter and `abortIncompleteMultipartUpload.daysAfterInitiation: 1`.
  - Both rules are `Enabled`.
  - Add a comment that points at this change's design.md (decisions 1–3) and states that the expiry must outlive the DLQ.

  Verify with `pnpm nx run infra:typecheck` (check the target name with `pnpm nx show project infra`).
- [x] 4.3 In `infra/src/guardrails.spec.ts`, assert that:
  - exactly one recorded `aws:s3/bucketLifecycleConfiguration:BucketLifecycleConfiguration` targets the uploads bucket;
  - it has an `Enabled` rule with prefix `uploads/`, `expiration.days === 30` and `noncurrentVersionExpiration.noncurrentDays === 1`;
  - it has an `Enabled` rule with `abortIncompleteMultipartUpload.daysAfterInitiation === 1`;
  - the `ingestion-dlq` queue has `messageRetentionSeconds === 1209600`.

  Verify with `pnpm nx run infra:test`. Then temporarily delete the lifecycle resource and confirm the test fails before restoring it.
- [x] 4.4 Run `pnpm nx run infra:preview` against the stack and confirm the plan: one lifecycle configuration and one queue update are created, and an update to the `presigned-upload` function (the new bundle), with no replacements. Verify by pasting the preview summary into the PR description.

  - Preview result (2026-11-14): 1 to create (`aws:s3:BucketLifecycleConfiguration uploads`), 13 to update, 1 to replace, 165 unchanged.
    - The updates are `ingestion-dlq` (`messageRetentionSeconds`) and 12 Lambda `code` updates. Every bundle that includes `shared` changed.
    - The replacement is the `aws:lambda:Invocation migrate-database`, whose trigger hashes the bundle. It re-runs the idempotent migration function.
    - No infra resource is replaced.

## 5. Documentation

- [x] 5.1 Add an "Upload a statement by hand" section to `ingestion/README.md`. It shows `POST /uploads` with `{"accountId": "…"}` returning `{ url, fields }`, and a `curl` example that sends every field with `--form-string` and the file last (`-F file=@statement.csv`). It also lists the limits (1 byte–10 MiB, `text/csv`, 15-minute expiry) and the errors S3 returns (`EntityTooLarge`, `EntityTooSmall`, `AccessDenied` on an expired policy). Verify with `pnpm exec prettier --check ingestion/README.md`.
- [x] 5.2 In `infra/README.md`, add the optional `uploadRetentionDays` key next to `logRetentionDays`, with the default, the floor of more than 14 because of DLQ retention, and `pulumi config set uploadRetentionDays 60`. Add a short "Upload retention" note describing both lifecycle rules and the irreversible first sweep, with the optional `aws s3 sync` backup. Verify with `pnpm exec prettier --check infra/README.md`.
- [x] 5.3 Add a dated amendment to `docs/adr/0008-statement-data-model.md`: layer 1 is now kept for `uploadRetentionDays` (default 30), and raw rows are the durable record, apart from header column order. Keep the original text. In `docs/architecture.md`, relabel the presign edge to "presigns a POST policy (≤ 10 MiB) for", and the CSV node to "S3 uploads bucket, expires after 30 days". Verify with `grep -n "unchanged" docs/architecture.md` showing no stale CSV claim, and that `pnpm exec prettier --check docs` passes.

## 6. End-to-end check and validation

- [x] 6.1 After deploy:
  - run `aws s3api get-bucket-lifecycle-configuration --bucket "$(pulumi stack output uploadsBucketName)"` and confirm both rules;
  - upload a real small CSV with the README `curl` example and confirm the chat or database outcome;
  - upload an 11 MiB file and a 0-byte file, and confirm `EntityTooLarge` / `EntityTooSmall`, with `aws s3api head-object` returning 404 for the key;
  - resolve design.md's open question: POST the same form twice and record whether the second POST overwrites (expected) or returns `412`.

  Verify by recording the results in the PR description.
  - Partial results (2026-11-14, after `pulumi up`: 1 created, 13 updated, 1 replaced):
    - The lifecycle configuration shows both rules (`expire-uploads` 30 days with noncurrent 1 day, `abort-incomplete-multipart-uploads` 1 day). DLQ `MessageRetentionPeriod` is 1209600.
    - The deployed `presigned-upload` Lambda, invoked directly with real claims, returned `201 { url, fields }`. Its policy has `content-length-range` 1..10485760, `Content-Type` `text/csv`, and the exact bucket and key.
    - With that form, an 11 MiB file got `400 EntityTooLarge` and a 0-byte file got `400 EntityTooSmall`. `head-object` on the key returned 404.
    - Accepted upload (owner approved): a 2-line non-bank CSV POSTed with a fresh form got `204`, and its ETag matched its MD5. The `ingest` log shows `statement-processed`, `status: rejected` (unknown format), `redelivered: false`.
    - Replay: POSTing different bytes with the same form also got `204`, and the ETag changed to the second file's MD5. So S3 overwrites; POST Object has no conditional write.
    - The replay's event logged `redelivered: true` with the same `fileId`. There was exactly one outcome per key, and the DLQ is empty. This matches design.md decision 5.
- [x] 6.2 Run `pnpm exec openspec validate expire-uploads-and-enforce-size-at-s3 --strict` and `pnpm nx affected -t lint,test,typecheck`, and confirm both pass.
  - Result: `openspec validate --strict` passes. The uncached parallel `test` run passes all four projects (311, 284, 194, 87), and `lint` passes.
    - The infra guardrails `beforeAll` took 12s under load on the 2-vCPU VPS, which exceeded vitest's 10s hook default and caused the earlier flake. It now has a 60s timeout.
