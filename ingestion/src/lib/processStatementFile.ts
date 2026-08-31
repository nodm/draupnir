import { randomUUID } from 'node:crypto';
import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import {
  batchExecuteStatement,
  beginTransaction,
  commitTransaction,
  executeStatement,
  rollbackTransaction,
  type DataApiConfig,
} from './dataApi';
import type { StatementParser } from './parsers/types';

export type ParserDispatch = Record<string, StatementParser>;

// The Lambda buffers the whole object into memory via transformToString —
// a bound here keeps an oversized upload from exhausting it. Generous for
// a CSV bank statement (even a multi-year export is a few MB of text at
// most), since a presigned PUT URL can't itself carry a size limit the
// way a presigned POST policy's content-length-range can.
const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024;

// Inserting one row per Data API round trip doesn't fit the Lambda's
// timeout for a statement with thousands of rows — batching keeps the
// round-trip count roughly constant regardless of file size, well inside
// BatchExecuteStatement's 4-MiB-per-call request limit for rows this narrow.
const INSERT_BATCH_SIZE = 500;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export class MissingUploadAccountError extends Error {
  constructor() {
    super('The upload-selected account no longer exists');
    this.name = 'MissingUploadAccountError';
  }
}

export class UnresolvableRowIbanError extends Error {
  constructor(iban: string) {
    super(`No account owned by the uploader matches iban ${iban}`);
    this.name = 'UnresolvableRowIbanError';
  }
}

export class EmptyStatementFileError extends Error {
  constructor() {
    super('Parsed statement file produced no transaction rows');
    this.name = 'EmptyStatementFileError';
  }
}

export class OversizedStatementFileError extends Error {
  constructor(sizeBytes: number) {
    super(
      `Statement file is ${sizeBytes} bytes, exceeding the ${MAX_UPLOAD_SIZE_BYTES}-byte limit`,
    );
    this.name = 'OversizedStatementFileError';
  }
}

interface ObjectKeyParts {
  ownerUserId: string;
  accountId: string;
}

// Object key shape: uploads/{sub}/{accountId}/{uuid}.csv — see
// statement-csv-upload spec.
function parseObjectKey(key: string): ObjectKeyParts {
  const match = /^uploads\/([^/]+)\/([^/]+)\/[^/]+$/.exec(key);
  if (!match) {
    throw new Error(`Unrecognized upload object key: ${key}`);
  }
  return {
    ownerUserId: match[1] as string,
    accountId: match[2] as string,
  };
}

interface AccountRow {
  id: string;
  bank: string;
  iban: string;
}

export async function processStatementFile(
  dataApiClient: RDSDataClient,
  dataApiConfig: DataApiConfig,
  s3Client: S3Client,
  parsers: ParserDispatch,
  bucket: string,
  key: string,
  objectSizeBytes: number,
): Promise<void> {
  if (objectSizeBytes > MAX_UPLOAD_SIZE_BYTES) {
    throw new OversizedStatementFileError(objectSizeBytes);
  }

  const { ownerUserId, accountId } = parseObjectKey(key);

  const { rows: uploadAccountRows } = await executeStatement(
    dataApiClient,
    dataApiConfig,
    'SELECT id, bank, iban FROM accounts WHERE id = :accountId AND owner_user_id = :ownerUserId',
    { accountId, ownerUserId },
  );

  if (uploadAccountRows.length === 0) {
    throw new MissingUploadAccountError();
  }

  const uploadAccount = uploadAccountRows[0] as unknown as AccountRow;

  const parser = parsers[uploadAccount.bank];
  if (!parser) {
    throw new Error(`No parser registered for bank: ${uploadAccount.bank}`);
  }

  const object = await s3Client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  if (!object.Body) {
    throw new Error(`S3 object has no body: ${bucket}/${key}`);
  }
  // The S3 event's object.size can be stale by the time this runs — the
  // key is reusable until the presigned URL expires, so a small first
  // upload could be overwritten with a large one before this Lambda picks
  // up the event. Re-check the actual object's size, from this GetObject
  // response itself, before buffering the body.
  if (
    object.ContentLength !== undefined &&
    object.ContentLength > MAX_UPLOAD_SIZE_BYTES
  ) {
    throw new OversizedStatementFileError(object.ContentLength);
  }
  const fileContents = await object.Body.transformToString('utf-8');

  // Parsing the whole file before any DB write means a parse failure — at
  // any row — naturally leaves no partial write, per the
  // statement-ingestion-pipeline spec.
  const parsedRows = parser(fileContents, uploadAccount.iban);
  if (parsedRows.length === 0) {
    throw new EmptyStatementFileError();
  }

  const resolvedAccountIdByIban = new Map<string, string>();
  for (const iban of new Set(parsedRows.map((row) => row.iban))) {
    const { rows } = await executeStatement(
      dataApiClient,
      dataApiConfig,
      'SELECT id FROM accounts WHERE iban = :iban AND owner_user_id = :ownerUserId',
      { iban, ownerUserId },
    );
    if (rows.length === 0) {
      throw new UnresolvableRowIbanError(iban);
    }
    resolvedAccountIdByIban.set(iban, (rows[0] as { id: string }).id);
  }

  const insertSql = `INSERT INTO transactions
       (id, owner_user_id, account_id, posted_date, amount_minor_units, currency, description, dedup_key,
        original_currency, original_amount_minor_units, fx_fee_minor_units, fx_fee_percent)
     VALUES (:id, :ownerUserId, :accountId, :postedDate, :amountMinorUnits, :currency, :description, :dedupKey,
             :originalCurrency, :originalAmountMinorUnits, :fxFeeMinorUnits, :fxFeePercent)
     ON CONFLICT (dedup_key) DO NOTHING`;

  const transactionId = await beginTransaction(dataApiClient, dataApiConfig);
  try {
    for (const batch of chunk(parsedRows, INSERT_BATCH_SIZE)) {
      await batchExecuteStatement(
        dataApiClient,
        dataApiConfig,
        insertSql,
        batch.map((row) => ({
          id: randomUUID(),
          ownerUserId,
          accountId: resolvedAccountIdByIban.get(row.iban) as string,
          postedDate: row.postedDate,
          amountMinorUnits: row.amountMinorUnits,
          currency: row.currency,
          description: row.description,
          dedupKey: row.dedupKey,
          originalCurrency: row.originalCurrency ?? null,
          originalAmountMinorUnits: row.originalAmountMinorUnits ?? null,
          fxFeeMinorUnits: row.fxFeeMinorUnits ?? null,
          fxFeePercent: row.fxFeePercent ?? null,
        })),
        transactionId,
      );
    }
    await commitTransaction(dataApiClient, dataApiConfig, transactionId);
  } catch (error) {
    await rollbackTransaction(dataApiClient, dataApiConfig, transactionId);
    throw error;
  }
}
