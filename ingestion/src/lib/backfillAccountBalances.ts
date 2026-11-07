import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import {
  executeStatement,
  recomputeAccountBalance,
  withCaller,
  type AccountBalance,
  type DataApiConfig,
} from 'shared';
import { deriveTransactions } from './derive';
import { RebuildAccountNotFoundError } from './rebuildAccount';
import { batchInsert } from './statementWrites';
import { loadStoredRawRows } from './storedRawRows';

const LOCK_TIMEOUT = '30s';

export interface BackfillResult extends AccountBalance {
  accountId: string;
  // Stored transactions that got their order key from the raw rows.
  transactions: number;
  // Stored transactions no raw row derives (still without an order key); not
  // zero means the account needs a look before the NOT NULL migration.
  withoutOrderKey: number;
}

// Gives an existing account its order keys, running balances and balance
// without touching a row's identity: the raw rows are normalized in memory and
// each stored transaction is UPDATEd by `dedup_key`; nothing is deleted or
// inserted, so transaction ids and their sources survive (`rebuildAccount`
// deletes and re-inserts, which is not safe on prod data that must be kept).
// Runs under the account lock imports take, and a second run changes nothing.
export async function backfillAccountBalances(
  client: RDSDataClient,
  config: DataApiConfig,
  // An owner of the account: row-level security hides it from anyone else.
  sub: string,
  accountId: string,
): Promise<BackfillResult> {
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
    if (!account) throw new RebuildAccountNotFoundError(accountId);

    const { filesInOrder } = await loadStoredRawRows(
      client,
      config,
      transactionId,
      accountId,
      account.iban,
    );
    const { transactions } = deriveTransactions(filesInOrder);

    await batchInsert(
      client,
      config,
      transactionId,
      `UPDATE transactions
          SET occurred_at = CAST(:occurredAt AS timestamptz), source_seq = :sourceSeq
        WHERE account_id = :accountId AND dedup_key = :dedupKey
          AND (occurred_at IS DISTINCT FROM CAST(:occurredAt AS timestamptz)
               OR source_seq IS DISTINCT FROM :sourceSeq)`,
      transactions.map(({ row }) => ({
        accountId,
        dedupKey: row.dedupKey,
        occurredAt: row.occurredAt,
        sourceSeq: row.sourceSeq,
      })),
    );

    const balance = await recomputeAccountBalance(
      client,
      config,
      transactionId,
      accountId,
    );
    const { rows } = await executeStatement(
      client,
      config,
      `SELECT count(*) FILTER (WHERE occurred_at IS NULL OR source_seq IS NULL) AS without_key,
              count(*) AS total
         FROM transactions WHERE account_id = :accountId`,
      { accountId },
      transactionId,
    );
    const counts = rows[0] as { without_key: number; total: number };
    return {
      accountId,
      ...balance,
      transactions: counts.total - counts.without_key,
      withoutOrderKey: counts.without_key,
    };
  });
}
