import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import {
  beginTransaction,
  commitTransaction,
  executeStatement,
  rollbackTransaction,
  type Bank,
  type DataApiConfig,
} from 'shared';
import { deriveTransactions, type DerivationFile } from './derive';
import { batchInsert, writeDerivation } from './statementWrites';

const LOCK_TIMEOUT = '30s';

export interface RebuildResult {
  accountId: string;
  transactions: number;
  sources: number;
}

interface StoredRawRow {
  id: string;
  file_id: string;
  row_number: number;
  bank: Bank;
  payload: string;
}

export class RebuildAccountNotFoundError extends Error {
  constructor(accountId: string) {
    super(`Account not found: ${accountId}`);
    this.name = 'RebuildAccountNotFoundError';
  }
}

// Re-derives one account's `transactions` and `transaction_sources` from its
// own raw rows of approved files, oldest import first, under the same account
// lock imports take. Raw rows are authoritative, so after a normalization fix
// this updates transactions without any re-upload. Works the same for an
// account that only appears as a non-selected account of a multi-account file,
// because it reads `raw_rows.account_id`, never the file's upload account.
export async function rebuildAccount(
  client: RDSDataClient,
  config: DataApiConfig,
  accountId: string,
): Promise<RebuildResult> {
  const transactionId = await beginTransaction(client, config);
  try {
    await executeStatement(
      client,
      config,
      `SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`,
      {},
      transactionId,
    );
    const { rows: accountRows } = await executeStatement(
      client,
      config,
      'SELECT id, iban FROM accounts WHERE id = :accountId FOR UPDATE',
      { accountId },
      transactionId,
    );
    const account = accountRows[0] as { id: string; iban: string } | undefined;
    if (!account) {
      throw new RebuildAccountNotFoundError(accountId);
    }

    const { rows } = await executeStatement(
      client,
      config,
      `SELECT r.id, r.file_id, r.row_number, r.bank, CAST(r.payload AS text) AS payload
         FROM raw_rows r
         JOIN statement_files f ON f.id = r.file_id AND f.status = 'approved'
         JOIN statement_file_accounts fa ON fa.file_id = r.file_id AND fa.account_id = r.account_id
        WHERE r.account_id = :accountId
        ORDER BY f.import_seq, r.row_number`,
      { accountId },
      transactionId,
    );

    const filesInOrder: DerivationFile[] = [];
    const fileIdByRawRow = new Map<string, string>();
    const fileIndex = new Map<string, DerivationFile>();
    for (const raw of rows as unknown as StoredRawRow[]) {
      let file = fileIndex.get(raw.file_id);
      if (!file) {
        file = {
          bank: raw.bank,
          accountId,
          accountIban: account.iban,
          rows: [],
        };
        fileIndex.set(raw.file_id, file);
        filesInOrder.push(file);
      }
      file.rows.push({
        rawRowId: raw.id,
        rowNumber: raw.row_number,
        payload: JSON.parse(raw.payload) as Record<string, string>,
      });
      fileIdByRawRow.set(raw.id, raw.file_id);
    }

    await executeStatement(
      client,
      config,
      'DELETE FROM transaction_sources WHERE account_id = :accountId',
      { accountId },
      transactionId,
    );
    await executeStatement(
      client,
      config,
      'DELETE FROM transactions WHERE account_id = :accountId',
      { accountId },
      transactionId,
    );

    const derivation = deriveTransactions(filesInOrder);
    await writeDerivation(client, config, transactionId, derivation);

    // The file whose row first produced a transaction is the one that "created"
    // it; refresh each file's new-transaction count accordingly.
    const firstSource = new Map<string, string>();
    for (const source of derivation.sources) {
      if (!firstSource.has(source.transactionId)) {
        firstSource.set(source.transactionId, source.rawRowId);
      }
    }
    const createdByFile = new Map<string, number>(
      [...fileIndex.keys()].map((id) => [id, 0]),
    );
    for (const rawRowId of firstSource.values()) {
      const fileId = fileIdByRawRow.get(rawRowId) as string;
      createdByFile.set(fileId, (createdByFile.get(fileId) ?? 0) + 1);
    }
    await batchInsert(
      client,
      config,
      transactionId,
      `UPDATE statement_file_accounts SET new_transaction_count = :count
        WHERE file_id = :fileId AND account_id = :accountId`,
      [...createdByFile].map(([fileId, count]) => ({
        fileId,
        accountId,
        count,
      })),
    );

    await commitTransaction(client, config, transactionId);
    return {
      accountId,
      transactions: derivation.transactions.length,
      sources: derivation.sources.length,
    };
  } catch (error) {
    try {
      await rollbackTransaction(client, config, transactionId);
    } catch {
      // surface the original error
    }
    throw error;
  }
}
