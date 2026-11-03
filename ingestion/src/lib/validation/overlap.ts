import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import { executeStatement, type DataApiConfig } from 'shared';
import { formatMinorUnits } from '../dedupKey';
import type { NormalizedRow } from '../parsers/types';
import type { ValidationReason } from './types';

export interface OverlapCandidate {
  rowNumber: number;
  normalized: NormalizedRow;
}

interface StoredTransaction {
  dedup_key: string;
  posted_date: string;
  amount_minor_units: number;
  currency: string;
  fee_minor_units: number;
  balance_after_minor_units: number | null;
}

// Keys travel as one JSON text parameter and are unnested server-side, so the
// statement has a fixed shape whatever the file size.
const KEYS_PER_QUERY = 2000;

function summary(postedDate: string, amount: number, currency: string): string {
  return `${postedDate}, ${formatMinorUnits(amount, currency)} ${currency}`;
}

function differs(stored: StoredTransaction, row: NormalizedRow): boolean {
  return (
    stored.posted_date !== row.postedDate ||
    stored.amount_minor_units !== row.amountMinorUnits ||
    stored.currency !== row.currency ||
    stored.fee_minor_units !== row.feeMinorUnits ||
    (stored.balance_after_minor_units ?? null) !==
      (row.balanceAfterMinorUnits ?? null)
  );
}

// Rows of one file sharing a dedup key must agree with each other, since only
// one transaction will be stored for the key.
export function findInFileKeyConflicts(
  rows: readonly OverlapCandidate[],
): ValidationReason[] {
  const first = new Map<string, OverlapCandidate>();
  const reasons: ValidationReason[] = [];
  for (const row of rows) {
    const earlier = first.get(row.normalized.dedupKey);
    if (!earlier) {
      first.set(row.normalized.dedupKey, row);
      continue;
    }
    const a = earlier.normalized;
    const b = row.normalized;
    if (
      a.postedDate !== b.postedDate ||
      a.amountMinorUnits !== b.amountMinorUnits ||
      a.currency !== b.currency ||
      a.feeMinorUnits !== b.feeMinorUnits ||
      (a.balanceAfterMinorUnits ?? null) !== (b.balanceAfterMinorUnits ?? null)
    ) {
      reasons.push({
        code: 'conflicting-duplicate-in-file',
        row: row.rowNumber,
        message: `Row ${row.rowNumber} has the same transaction id as row ${earlier.rowNumber} but different values`,
      });
    }
  }
  return reasons;
}

// Rejects the file when any row whose dedup key already exists for the account
// disagrees with the stored transaction. Must run inside the write transaction
// after the account is locked, so the stored history can't change underneath.
export async function findOverlapConflicts(
  client: RDSDataClient,
  config: DataApiConfig,
  transactionId: string,
  accountId: string,
  rows: readonly OverlapCandidate[],
): Promise<ValidationReason[]> {
  const byKey = new Map<string, OverlapCandidate[]>();
  for (const row of rows) {
    byKey.set(row.normalized.dedupKey, [
      ...(byKey.get(row.normalized.dedupKey) ?? []),
      row,
    ]);
  }

  const keys = [...byKey.keys()];
  const reasons: ValidationReason[] = [];
  for (let i = 0; i < keys.length; i += KEYS_PER_QUERY) {
    const { rows: stored } = await executeStatement(
      client,
      config,
      `SELECT dedup_key, posted_date, amount_minor_units, currency, fee_minor_units, balance_after_minor_units
         FROM transactions
        WHERE account_id = :accountId
          AND dedup_key IN (SELECT jsonb_array_elements_text(CAST(:keys AS jsonb)))`,
      {
        accountId,
        keys: JSON.stringify(keys.slice(i, i + KEYS_PER_QUERY)),
      },
      transactionId,
    );
    for (const record of stored as unknown as StoredTransaction[]) {
      for (const candidate of byKey.get(record.dedup_key) ?? []) {
        if (differs(record, candidate.normalized)) {
          const n = candidate.normalized;
          reasons.push({
            code: 'conflicting-overlap',
            row: candidate.rowNumber,
            message: `Row ${candidate.rowNumber} (${summary(n.postedDate, n.amountMinorUnits, n.currency)}) conflicts with the stored transaction ${summary(record.posted_date, record.amount_minor_units, record.currency)}`,
          });
        }
      }
    }
  }
  return reasons.sort((a, b) => (a.row ?? 0) - (b.row ?? 0));
}
