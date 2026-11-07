import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import { executeStatement, type Bank, type DataApiConfig } from 'shared';
import type { DerivationFile } from './derive';

const PAGE_SIZE = 200;

interface StoredRawRow {
  id: string;
  file_id: string;
  row_number: number;
  bank: Bank;
  payload: string;
}

export interface StoredRawRows {
  // One entry per approved file of the account, oldest import first.
  filesInOrder: DerivationFile[];
  fileIndex: Map<string, DerivationFile>;
  fileIdByRawRow: Map<string, string>;
}

// An account's raw rows of approved files, grouped per file in commit order
// (`import_seq`). Raw rows are authoritative: rebuild and the balance backfill
// both derive from them, so a normalization change needs no re-upload. Reads
// `raw_rows.account_id`, never a file's upload account, so a non-selected
// account of a multi-account file is covered too.
export async function loadStoredRawRows(
  client: RDSDataClient,
  config: DataApiConfig,
  transactionId: string,
  accountId: string,
  accountIban: string,
  pageSize = PAGE_SIZE,
): Promise<StoredRawRows> {
  // The Data API caps one result at 1 MB and a raw payload is about a
  // kilobyte, so a large account is read in keyset pages ordered by
  // (import_seq, row_number), which is unique.
  const rows: StoredRawRow[] = [];
  let after: { importSeq: number; rowNumber: number } | null = null;
  for (;;) {
    const { rows: page } = await executeStatement(
      client,
      config,
      `SELECT r.id, r.file_id, r.row_number, r.bank, CAST(r.payload AS text) AS payload,
              f.import_seq
         FROM raw_rows r
         JOIN statement_files f ON f.id = r.file_id AND f.status = 'approved'
         JOIN statement_file_accounts fa ON fa.file_id = r.file_id AND fa.account_id = r.account_id
        WHERE r.account_id = :accountId
          AND (:hasAfter = false OR (f.import_seq, r.row_number) > (CAST(:afterSeq AS bigint), CAST(:afterRow AS integer)))
        ORDER BY f.import_seq, r.row_number
        LIMIT CAST(:pageSize AS bigint)`,
      {
        accountId,
        hasAfter: after !== null,
        afterSeq: after?.importSeq ?? 0,
        afterRow: after?.rowNumber ?? 0,
        pageSize,
      },
      transactionId,
    );
    const batch = page as unknown as (StoredRawRow & { import_seq: number })[];
    rows.push(...batch);
    const last = batch[batch.length - 1];
    if (batch.length < pageSize || !last) break;
    after = { importSeq: last.import_seq, rowNumber: last.row_number };
  }

  const filesInOrder: DerivationFile[] = [];
  const fileIdByRawRow = new Map<string, string>();
  const fileIndex = new Map<string, DerivationFile>();
  for (const raw of rows) {
    let file = fileIndex.get(raw.file_id);
    if (!file) {
      file = { bank: raw.bank, accountId, accountIban, rows: [] };
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
  return { filesInOrder, fileIndex, fileIdByRawRow };
}
