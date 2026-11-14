import { randomUUID } from 'node:crypto';
import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import type { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { requireSub } from './auth';
import { getMemberRole, MAX_STATEMENT_BYTES, type DataApiConfig } from 'shared';

const PRESIGNED_POST_TTL_SECONDS = 900;
const CONTENT_TYPE = 'text/csv';

export class AccountNotFoundError extends Error {
  constructor() {
    super('Account does not exist or the caller is not an owner of it');
    this.name = 'AccountNotFoundError';
  }
}

export interface PresignedUploadInput {
  accountId: string;
}

// A presigned POST: the client sends a multipart/form-data POST to `url` with
// every entry of `fields` as a form field and the file last, as `file`. The
// object key is `fields.key`.
export interface PresignedUpload {
  url: string;
  fields: Record<string, string>;
}

export interface UploadsBucketConfig {
  bucket: string;
}

export function loadUploadsBucketConfigFromEnv(): UploadsBucketConfig {
  const bucket = process.env['UPLOADS_BUCKET'];
  if (!bucket) {
    throw new Error('Missing UPLOADS_BUCKET environment variable');
  }
  return { bucket };
}

export async function createPresignedUpload(
  dataApiClient: RDSDataClient,
  dataApiConfig: DataApiConfig,
  s3Client: S3Client,
  bucketConfig: UploadsBucketConfig,
  claims: { [name: string]: string },
  input: PresignedUploadInput,
): Promise<PresignedUpload> {
  const sub = requireSub(claims);

  // Uploading changes an account's history, so only an owner may; a viewer, a
  // non-member and a nonexistent account are indistinguishable to the caller.
  const role = await getMemberRole(
    dataApiClient,
    dataApiConfig,
    input.accountId,
    sub,
  );
  if (role !== 'owner') {
    throw new AccountNotFoundError();
  }

  const key = `uploads/${sub}/${input.accountId}/${randomUUID()}.csv`;

  // The signed policy pins the bucket and exact key (added by the SDK), the
  // content type, and the size: S3 refuses an empty or oversized file before
  // storing anything. POST Object has no conditional write, so a replay of this
  // form within its TTL overwrites the object instead of getting a 412; the
  // worker still records one outcome per key. See
  // openspec/changes/archive/2026-11-14-expire-uploads-and-enforce-size-at-s3/design.md (decision 5).
  const { url, fields } = await createPresignedPost(s3Client, {
    Bucket: bucketConfig.bucket,
    Key: key,
    Fields: { 'Content-Type': CONTENT_TYPE },
    Conditions: [
      ['content-length-range', 1, MAX_STATEMENT_BYTES],
      ['eq', '$Content-Type', CONTENT_TYPE],
    ],
    Expires: PRESIGNED_POST_TTL_SECONDS,
  });

  return { url, fields };
}
