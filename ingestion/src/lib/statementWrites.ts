import { randomUUID } from 'node:crypto';
import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import {
  batchExecuteStatement,
  dateParameter,
  executeStatement,
  type DataApiConfig,
  type SqlParameterValue,
} from 'shared';
import type { Derivation } from './derive';

// Data API caps one request at 4 MiB and one batch at 1000 parameter sets.
// Raw payloads make rows far larger than a normalized transaction, so chunks
// are cut by serialized parameter bytes (with headroom for the SQL text and
// request envelope), not by a fixed row count.
const MAX_BATCH_BYTES = 3 * 1024 * 1024;
const MAX_BATCH_ITEMS = 500;

export class OversizedParameterSetError extends Error {
  constructor(sizeBytes: number, maxBytes: number) {
    super(
      `A single parameter set is ${sizeBytes} bytes, over the ${maxBytes}-byte batch limit`,
    );
    this.name = 'OversizedParameterSetError';
  }
}

export function chunkBySize<T>(
  items: readonly T[],
  sizeOf: (item: T) => number,
  maxBytes: number = MAX_BATCH_BYTES,
  maxItems: number = MAX_BATCH_ITEMS,
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = sizeOf(item);
    // One item over the limit can't be split, and sending it would breach the
    // Data API request cap; callers reject such input earlier.
    if (size > maxBytes) {
      throw new OversizedParameterSetError(size, maxBytes);
    }
    if (
      current.length > 0 &&
      (bytes + size > maxBytes || current.length >= maxItems)
    ) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

type Params = Record<string, SqlParameterValue>;

function paramBytes(params: Params): number {
  return Buffer.byteLength(JSON.stringify(params), 'utf8');
}

export async function batchInsert(
  client: RDSDataClient,
  config: DataApiConfig,
  transactionId: string,
  sql: string,
  parameterSets: readonly Params[],
): Promise<void> {
  for (const chunk of chunkBySize(parameterSets, paramBytes)) {
    await batchExecuteStatement(client, config, sql, chunk, transactionId);
  }
}

export interface RawRowInsert {
  id: string;
  fileId: string;
  accountId: string;
  rowNumber: number;
  bank: string;
  formatVersion: string;
  bankTransactionId: string | null;
  payload: Record<string, string>;
}

export function insertRawRows(
  client: RDSDataClient,
  config: DataApiConfig,
  transactionId: string,
  rows: readonly RawRowInsert[],
): Promise<void> {
  return batchInsert(
    client,
    config,
    transactionId,
    `INSERT INTO raw_rows (id, file_id, account_id, row_number, bank, format_version, bank_transaction_id, payload)
     VALUES (:id, :fileId, :accountId, :rowNumber, :bank, :formatVersion, :bankTransactionId, CAST(:payload AS jsonb))`,
    rows.map((r) => ({
      id: r.id,
      fileId: r.fileId,
      accountId: r.accountId,
      rowNumber: r.rowNumber,
      bank: r.bank,
      formatVersion: r.formatVersion,
      bankTransactionId: r.bankTransactionId,
      payload: JSON.stringify(r.payload),
    })),
  );
}

export interface WriteDerivationResult {
  // Transactions that did not exist before, per account.
  newTransactionsByAccount: Map<string, number>;
  // Derived transaction id -> id actually stored (differs when the key already
  // existed).
  storedIdByDerivedId: Map<string, string>;
}

// Inserts derived transactions (a key that already exists for the account is
// left untouched), resolves every derived transaction to its stored id, and
// links each raw row to it. Runs inside the caller's transaction.
export async function writeDerivation(
  client: RDSDataClient,
  config: DataApiConfig,
  transactionId: string,
  derivation: Derivation,
): Promise<WriteDerivationResult> {
  await batchInsert(
    client,
    config,
    transactionId,
    `INSERT INTO transactions
       (id, account_id, posted_date, amount_minor_units, currency, description, fee_minor_units,
        balance_after_minor_units, dedup_key, original_currency, original_amount_minor_units,
        fx_fee_minor_units, fx_fee_percent, occurred_at, source_seq)
     VALUES (:id, :accountId, :postedDate, :amountMinorUnits, :currency, :description, :feeMinorUnits,
             :balanceAfterMinorUnits, :dedupKey, :originalCurrency, :originalAmountMinorUnits,
             :fxFeeMinorUnits, :fxFeePercent, CAST(:occurredAt AS timestamptz), :sourceSeq)
     ON CONFLICT (account_id, dedup_key) DO NOTHING`,
    derivation.transactions.map(({ id, accountId, row }) => ({
      id,
      accountId,
      postedDate: dateParameter(row.postedDate),
      amountMinorUnits: row.amountMinorUnits,
      currency: row.currency,
      description: row.description,
      feeMinorUnits: row.feeMinorUnits,
      balanceAfterMinorUnits: row.balanceAfterMinorUnits ?? null,
      dedupKey: row.dedupKey,
      originalCurrency: row.originalCurrency ?? null,
      originalAmountMinorUnits: row.originalAmountMinorUnits ?? null,
      fxFeeMinorUnits: row.fxFeeMinorUnits ?? null,
      fxFeePercent: row.fxFeePercent ?? null,
      occurredAt: row.occurredAt,
      sourceSeq: row.sourceSeq,
    })),
  );

  const keysByAccount = new Map<string, string[]>();
  for (const { accountId, row } of derivation.transactions) {
    keysByAccount.set(accountId, [
      ...(keysByAccount.get(accountId) ?? []),
      row.dedupKey,
    ]);
  }
  const storedIdByAccountKey = new Map<string, string>();
  for (const [accountId, keys] of keysByAccount) {
    for (const chunk of chunkBySize(
      keys,
      (k) => k.length + 8,
      1024 * 1024,
      2000,
    )) {
      const { rows } = await executeStatement(
        client,
        config,
        `SELECT id, dedup_key FROM transactions
          WHERE account_id = :accountId
            AND dedup_key IN (SELECT jsonb_array_elements_text(CAST(:keys AS jsonb)))`,
        { accountId, keys: JSON.stringify(chunk) },
        transactionId,
      );
      for (const r of rows as unknown as { id: string; dedup_key: string }[]) {
        storedIdByAccountKey.set(`${accountId}\u0000${r.dedup_key}`, r.id);
      }
    }
  }

  const storedIdByDerivedId = new Map<string, string>();
  const newTransactionsByAccount = new Map<string, number>();
  for (const { id, accountId, row } of derivation.transactions) {
    const stored = storedIdByAccountKey.get(
      `${accountId}\u0000${row.dedupKey}`,
    );
    if (!stored) {
      throw new Error(`Transaction not found after insert: ${row.dedupKey}`);
    }
    storedIdByDerivedId.set(id, stored);
    if (stored === id) {
      newTransactionsByAccount.set(
        accountId,
        (newTransactionsByAccount.get(accountId) ?? 0) + 1,
      );
    }
  }

  await batchInsert(
    client,
    config,
    transactionId,
    `INSERT INTO transaction_sources (transaction_id, raw_row_id, account_id)
     VALUES (:transactionId, :rawRowId, :accountId)
     ON CONFLICT DO NOTHING`,
    derivation.sources.map((s) => ({
      transactionId: storedIdByDerivedId.get(s.transactionId) as string,
      rawRowId: s.rawRowId,
      accountId: s.accountId,
    })),
  );

  return { newTransactionsByAccount, storedIdByDerivedId };
}

export const newId = (): string => randomUUID();
