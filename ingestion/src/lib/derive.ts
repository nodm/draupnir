import { randomUUID } from 'node:crypto';
import type { Bank } from 'shared';
import { normalizeRows as normalizeMonobank } from './parsers/monobank';
import { normalizeRows as normalizeRevolut } from './parsers/revolut';
import { normalizeRows as normalizeSeb } from './parsers/seb';
import type { NormalizedRow, RowNormalizer } from './parsers/types';

const NORMALIZERS: Record<Bank, RowNormalizer> = {
  seb: normalizeSeb,
  revolut: normalizeRevolut,
  monobank: normalizeMonobank,
};

// One account's share of one file's raw rows, in row-number order.
export interface DerivationFile {
  bank: Bank;
  accountId: string;
  accountIban: string;
  rows: {
    rawRowId: string;
    rowNumber: number;
    payload: Record<string, string>;
  }[];
}

export interface DerivedTransaction {
  id: string;
  accountId: string;
  row: NormalizedRow;
}

export interface DerivedSource {
  transactionId: string;
  rawRowId: string;
  accountId: string;
}

export interface Derivation {
  transactions: DerivedTransaction[];
  sources: DerivedSource[];
}

// Pure: raw rows in, transactions and source links out. The first row seen for
// an (account, dedup key) creates the transaction; every later row with the
// same key — in this file or a later one — only adds a source. Import and
// `rebuildAccount` both call this, so re-deriving after a normalization fix
// needs no re-upload.
export function deriveTransactions(
  files: readonly DerivationFile[],
  newId: () => string = randomUUID,
): Derivation {
  const transactions: DerivedTransaction[] = [];
  const sources: DerivedSource[] = [];
  const idByKey = new Map<string, string>();

  for (const file of files) {
    const normalized = NORMALIZERS[file.bank](
      file.rows.map(({ rowNumber, payload }) => ({ rowNumber, payload })),
      file.accountIban,
    );
    for (const raw of file.rows) {
      const row = normalized.get(raw.rowNumber);
      if (!row) continue;

      const key = `${file.accountId}\u0000${row.dedupKey}`;
      let transactionId = idByKey.get(key);
      if (transactionId === undefined) {
        transactionId = newId();
        idByKey.set(key, transactionId);
        transactions.push({ id: transactionId, accountId: file.accountId, row });
      }
      sources.push({
        transactionId,
        rawRowId: raw.rawRowId,
        accountId: file.accountId,
      });
    }
  }
  return { transactions, sources };
}
