import { randomUUID } from 'node:crypto';
import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import {
  beginTransaction,
  commitTransaction,
  executeStatement,
  rollbackTransaction,
  type DataApiConfig,
} from './dataApi';
import type { StatementParser } from './parsers/types';

export type ParserDispatch = Record<string, StatementParser>;

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
): Promise<void> {
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
  const fileContents = await object.Body.transformToString('utf-8');

  // Parsing the whole file before any DB write means a parse failure — at
  // any row — naturally leaves no partial write, per the
  // statement-ingestion-pipeline spec.
  const parsedRows = parser(fileContents, uploadAccount.iban);

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

  const transactionId = await beginTransaction(dataApiClient, dataApiConfig);
  try {
    for (const row of parsedRows) {
      await executeStatement(
        dataApiClient,
        dataApiConfig,
        `INSERT INTO transactions
           (id, owner_user_id, account_id, posted_date, amount_minor_units, currency, description, dedup_key,
            original_currency, original_amount_minor_units, fx_fee_minor_units, fx_fee_percent)
         VALUES (:id, :ownerUserId, :accountId, :postedDate, :amountMinorUnits, :currency, :description, :dedupKey,
                 :originalCurrency, :originalAmountMinorUnits, :fxFeeMinorUnits, :fxFeePercent)
         ON CONFLICT (dedup_key) DO NOTHING`,
        {
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
        },
        transactionId,
      );
    }
    await commitTransaction(dataApiClient, dataApiConfig, transactionId);
  } catch (error) {
    await rollbackTransaction(dataApiClient, dataApiConfig, transactionId);
    throw error;
  }
}
