import { randomUUID } from 'node:crypto';
import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { requireSub } from './auth';
import { executeStatement, type DataApiConfig } from './dataApi';

const PRESIGNED_URL_TTL_SECONDS = 900;

export class AccountNotFoundError extends Error {
  constructor() {
    super('Account does not exist or is not owned by the caller');
    this.name = 'AccountNotFoundError';
  }
}

export interface PresignedUploadInput {
  accountId: string;
}

export interface PresignedUpload {
  url: string;
  key: string;
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

  const { rows } = await executeStatement(
    dataApiClient,
    dataApiConfig,
    'SELECT id FROM accounts WHERE id = :accountId AND owner_user_id = :ownerUserId',
    { accountId: input.accountId, ownerUserId: sub },
  );

  if (rows.length === 0) {
    throw new AccountNotFoundError();
  }

  const key = `uploads/${sub}/${input.accountId}/${randomUUID()}.csv`;

  const url = await getSignedUrl(
    s3Client,
    new PutObjectCommand({
      Bucket: bucketConfig.bucket,
      Key: key,
      ContentType: 'text/csv',
      // Each key is a fresh random UUID, so the only way it's ever written
      // twice is the same presigned URL being replayed within its TTL. A
      // second write would silently replace the first upload's content
      // before its S3 notification is processed, losing that file. This
      // conditional-write header makes S3 reject any PUT to a key that
      // already exists, turning that race into a client-visible 412 instead.
      IfNoneMatch: '*',
    }),
    { expiresIn: PRESIGNED_URL_TTL_SECONDS },
  );

  return { url, key };
}
