import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import {
  executeStatement,
  recomputeAccountBalance,
  withCaller,
  type DataApiConfig,
} from 'shared';
import { deriveTransactions } from './derive';
import { loadStoredRawRows } from './storedRawRows';
import { batchInsert, writeDerivation } from './statementWrites';

const LOCK_TIMEOUT = '30s';

export interface RebuildResult {
  accountId: string;
  transactions: number;
  sources: number;
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
  // An owner of the account: row-level security hides the account from anyone
  // else, so a non-owner gets RebuildAccountNotFoundError.
  sub: string,
  accountId: string,
): Promise<RebuildResult> {
  return withCaller(client, config, sub, async (transactionId) => {
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

    const { filesInOrder, fileIndex, fileIdByRawRow } = await loadStoredRawRows(
      client,
      config,
      transactionId,
      accountId,
      account.iban,
    );

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

    // New order keys, so new running balances and account balance.
    await recomputeAccountBalance(client, config, transactionId, accountId);

    return {
      accountId,
      transactions: derivation.transactions.length,
      sources: derivation.sources.length,
    };
  });
}
