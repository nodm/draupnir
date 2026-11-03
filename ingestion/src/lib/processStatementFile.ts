import { createHash } from 'node:crypto';
import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import {
  beginTransaction,
  commitTransaction,
  dateParameter,
  executeStatement,
  getMemberRole,
  memberPredicate,
  rollbackTransaction,
  type Bank,
  type DataApiConfig,
} from 'shared';
import { deriveTransactions, type DerivationFile } from './derive';
import type { ParsedRow, ParsedStatement } from './parsers/types';
import {
  continuityWarnings,
  loadSegments,
  type CoverageAccount,
  type Segment,
} from './validation/coverage';
import {
  findInFileKeyConflicts,
  findOverlapConflicts,
  type OverlapCandidate,
} from './validation/overlap';
import type { ValidationReason } from './validation/types';
import { validateStatementFile } from './validation/validateStatement';
import { insertRawRows, newId, writeDerivation } from './statementWrites';

// The Lambda buffers the whole object into memory — a bound here keeps an
// oversized upload from exhausting it. Generous for a CSV bank statement (even
// a multi-year export is a few MB of text at most), since a presigned PUT URL
// can't itself carry a size limit the way a presigned POST policy's
// content-length-range can.
const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024;

// Waiting for another import's account lock must end before Data API's
// 45-second statement limit; a timeout is an unexpected error (retry → DLQ).
const LOCK_TIMEOUT = '30s';

const DUPLICATE_APPROVED_INDEX = 'statement_files_approved_sha256_idx';

export class MissingUploadAccountError extends Error {
  constructor() {
    super('The upload-selected account no longer exists');
    this.name = 'MissingUploadAccountError';
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

export interface StatementOutcome {
  fileId: string;
  status: 'approved' | 'rejected';
  // Hard reasons; empty for an approved file.
  reasons: ValidationReason[];
  // Per account id; empty for a rejected file.
  warningsByAccount: Record<string, ValidationReason[]>;
  // True when this call only returned the outcome recorded by an earlier one.
  redelivered: boolean;
}

interface ObjectKeyParts {
  uploaderSub: string;
  accountId: string;
}

// Object key shape: uploads/{sub}/{accountId}/{uuid}.csv — see
// statement-csv-upload spec.
function parseObjectKey(key: string): ObjectKeyParts {
  const match = /^uploads\/([^/]+)\/([^/]+)\/[^/]+$/.exec(key);
  if (!match) {
    throw new Error(`Unrecognized upload object key: ${key}`);
  }
  return { uploaderSub: match[1] as string, accountId: match[2] as string };
}

interface AccountRecord {
  id: string;
  bank: Bank;
  iban: string;
  currency: string;
  opened_on: string;
  opening_balance_minor_units: number;
}

interface Context {
  client: RDSDataClient;
  config: DataApiConfig;
}

function parseJsonColumn<T>(value: unknown, fallback: T): T {
  if (typeof value === 'string') return JSON.parse(value) as T;
  return (value as T | null | undefined) ?? fallback;
}

// Returns the outcome already committed for this S3 object, if any.
async function findRecordedOutcome(
  { client, config }: Context,
  key: string,
  transactionId?: string,
): Promise<StatementOutcome | null> {
  const { rows } = await executeStatement(
    client,
    config,
    `SELECT id, status, CAST(rejection_reasons AS text) AS rejection_reasons
       FROM statement_files WHERE s3_key = :key`,
    { key },
    transactionId,
  );
  const file = rows[0] as
    | { id: string; status: 'approved' | 'rejected'; rejection_reasons: string | null }
    | undefined;
  if (!file) return null;

  const warningsByAccount: Record<string, ValidationReason[]> = {};
  if (file.status === 'approved') {
    const { rows: perAccount } = await executeStatement(
      client,
      config,
      `SELECT account_id, CAST(warnings AS text) AS warnings
         FROM statement_file_accounts WHERE file_id = :fileId`,
      { fileId: file.id },
      transactionId,
    );
    for (const r of perAccount as unknown as { account_id: string; warnings: string }[]) {
      warningsByAccount[r.account_id] = parseJsonColumn(r.warnings, []);
    }
  }
  return {
    fileId: file.id,
    status: file.status,
    reasons: parseJsonColumn(file.rejection_reasons, []),
    warningsByAccount,
    redelivered: true,
  };
}

interface FileFacts {
  uploadAccountId: string;
  uploadedBy: string;
  bank: Bank;
  formatVersion: string | null;
  sha256: string;
  s3Key: string;
}

// Inserts the rejected file record. Returns false when this S3 object already
// has a record (a concurrent redelivery won the insert).
async function insertRejected(
  { client, config }: Context,
  facts: FileFacts,
  reasons: ValidationReason[],
  transactionId?: string,
): Promise<{ fileId: string; inserted: boolean }> {
  const fileId = newId();
  const { numberOfRecordsUpdated } = await executeStatement(
    client,
    config,
    `INSERT INTO statement_files
       (id, upload_account_id, uploaded_by, bank, format_version, sha256, s3_key, status, rejection_reasons)
     VALUES (:id, :uploadAccountId, :uploadedBy, :bank, :formatVersion, :sha256, :s3Key, 'rejected', CAST(:reasons AS jsonb))
     ON CONFLICT (s3_key) DO NOTHING`,
    {
      id: fileId,
      uploadAccountId: facts.uploadAccountId,
      uploadedBy: facts.uploadedBy,
      bank: facts.bank,
      formatVersion: facts.formatVersion,
      sha256: facts.sha256,
      s3Key: facts.s3Key,
      reasons: JSON.stringify(reasons),
    },
    transactionId,
  );
  return { fileId, inserted: numberOfRecordsUpdated > 0 };
}

// Records a rejection in its own transaction and returns the outcome. If the
// object turns out to be recorded already, that recorded outcome wins.
async function recordRejection(
  ctx: Context,
  facts: FileFacts,
  reasons: ValidationReason[],
): Promise<StatementOutcome> {
  const transactionId = await beginTransaction(ctx.client, ctx.config);
  try {
    const { fileId, inserted } = await insertRejected(ctx, facts, reasons, transactionId);
    await commitTransaction(ctx.client, ctx.config, transactionId);
    if (!inserted) {
      const recorded = await findRecordedOutcome(ctx, facts.s3Key);
      if (recorded) return recorded;
    }
    return { fileId, status: 'rejected', reasons, warningsByAccount: {}, redelivered: false };
  } catch (error) {
    await rollbackTransaction(ctx.client, ctx.config, transactionId);
    throw error;
  }
}

async function resolveRowAccounts(
  { client, config }: Context,
  uploaderSub: string,
  parsed: ParsedStatement,
): Promise<Map<string, AccountRecord>> {
  const ibans = [...new Set(parsed.rows.map((row) => row.iban))];
  const { rows } = await executeStatement(
    client,
    config,
    `SELECT a.id, a.bank, a.iban, a.currency, a.opened_on, a.opening_balance_minor_units
       FROM accounts a
      WHERE a.iban IN (SELECT jsonb_array_elements_text(CAST(:ibans AS jsonb)))
        AND ${memberPredicate('a', 'id', 'owner')}`,
    { ibans: JSON.stringify(ibans), sub: uploaderSub },
  );
  return new Map(
    (rows as unknown as AccountRecord[]).map((account) => [account.iban, account]),
  );
}

// Per-row account rules: every row's IBAN must resolve to an account the
// uploader owns, in the file's bank, and each transaction's currency must be
// the account's.
function accountReasons(
  parsed: ParsedStatement,
  uploadBank: Bank,
  accountByIban: Map<string, AccountRecord>,
): ValidationReason[] {
  const reasons: ValidationReason[] = [];
  const reported = new Set<string>();
  for (const row of parsed.rows) {
    const account = accountByIban.get(row.iban);
    if (!account) {
      if (!reported.has(row.iban)) {
        reported.add(row.iban);
        reasons.push({
          code: 'unresolvable-iban',
          row: row.rowNumber,
          message: `Row ${row.rowNumber}: no account you own matches iban ${row.iban}`,
        });
      }
      continue;
    }
    if (account.bank !== uploadBank && !reported.has(`bank:${account.id}`)) {
      reported.add(`bank:${account.id}`);
      reasons.push({
        code: 'bank-mismatch',
        row: row.rowNumber,
        message: `Row ${row.rowNumber}: account ${account.iban} belongs to ${account.bank}, not ${uploadBank}`,
      });
    }
    if (row.normalized && row.normalized.currency !== account.currency) {
      reasons.push({
        code: 'currency-mismatch',
        row: row.rowNumber,
        message: `Row ${row.rowNumber}: currency ${row.normalized.currency} differs from the account's ${account.currency}`,
      });
    }
  }
  return reasons;
}

function groupByAccount(
  parsed: ParsedStatement,
  accountByIban: Map<string, AccountRecord>,
): Map<string, { account: AccountRecord; rows: ParsedRow[] }> {
  const groups = new Map<string, { account: AccountRecord; rows: ParsedRow[] }>();
  for (const row of parsed.rows) {
    const account = accountByIban.get(row.iban) as AccountRecord;
    const group = groups.get(account.id) ?? { account, rows: [] };
    group.rows.push(row);
    groups.set(account.id, group);
  }
  return groups;
}

function overlapCandidates(rows: readonly ParsedRow[]): OverlapCandidate[] {
  return rows.flatMap((row) =>
    row.normalized ? [{ rowNumber: row.rowNumber, normalized: row.normalized }] : [],
  );
}

function activityBounds(rows: readonly ParsedRow[]): { from: string | null; to: string | null } {
  const dates = rows.flatMap((r) => (r.normalized ? [r.normalized.postedDate] : []));
  if (dates.length === 0) return { from: null, to: null };
  return {
    from: dates.reduce((a, b) => (a < b ? a : b)),
    to: dates.reduce((a, b) => (a > b ? a : b)),
  };
}

async function rollbackQuietly(ctx: Context, transactionId: string): Promise<void> {
  try {
    await rollbackTransaction(ctx.client, ctx.config, transactionId);
  } catch {
    // The original error is the one worth surfacing.
  }
}

export async function processStatementFile(
  dataApiClient: RDSDataClient,
  dataApiConfig: DataApiConfig,
  s3Client: S3Client,
  bucket: string,
  key: string,
  objectSizeBytes: number,
): Promise<StatementOutcome> {
  const ctx: Context = { client: dataApiClient, config: dataApiConfig };

  if (objectSizeBytes > MAX_UPLOAD_SIZE_BYTES) {
    throw new OversizedStatementFileError(objectSizeBytes);
  }

  // A redelivered message for an object whose outcome is already committed
  // returns that outcome — it must not be validated again, or the file would
  // be rejected as a duplicate of itself.
  const alreadyProcessed = await findRecordedOutcome(ctx, key);
  if (alreadyProcessed) return alreadyProcessed;

  const { uploaderSub, accountId } = parseObjectKey(key);

  const { rows: accountRows } = await executeStatement(
    dataApiClient,
    dataApiConfig,
    'SELECT id, bank, iban, currency FROM accounts WHERE id = :accountId',
    { accountId },
  );
  if (accountRows.length === 0) {
    throw new MissingUploadAccountError();
  }
  const uploadAccount = accountRows[0] as unknown as AccountRecord;

  const object = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!object.Body) {
    throw new Error(`S3 object has no body: ${bucket}/${key}`);
  }
  // The S3 event's object.size can be stale by the time this runs — the
  // key is reusable until the presigned URL expires, so a small first
  // upload could be overwritten with a large one before this Lambda picks
  // up the event. Re-check the actual object's size, from this GetObject
  // response itself, before buffering the body.
  if (object.ContentLength !== undefined && object.ContentLength > MAX_UPLOAD_SIZE_BYTES) {
    throw new OversizedStatementFileError(object.ContentLength);
  }
  const bytes = await object.Body.transformToByteArray();
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const fileContents = new TextDecoder('utf-8').decode(bytes);

  const facts: FileFacts = {
    uploadAccountId: uploadAccount.id,
    uploadedBy: uploaderSub,
    bank: uploadAccount.bank,
    formatVersion: null,
    sha256,
    s3Key: key,
  };

  // The uploader may have lost ownership since the presigned URL was issued.
  if ((await getMemberRole(dataApiClient, dataApiConfig, accountId, uploaderSub)) !== 'owner') {
    return recordRejection(ctx, facts, [
      { code: 'not-owner', message: 'The uploader is not an owner of the selected account' },
    ]);
  }

  // Everything that depends only on the file: format, every row, the chain.
  const validation = validateStatementFile(uploadAccount.bank, fileContents, uploadAccount.iban);
  if (!validation.ok) {
    return recordRejection(
      ctx,
      { ...facts, formatVersion: validation.formatVersion },
      validation.reasons,
    );
  }
  const { parsed, balances } = validation;
  facts.formatVersion = parsed.formatVersion;

  const accountByIban = await resolveRowAccounts(ctx, uploaderSub, parsed);
  const preReasons = accountReasons(parsed, uploadAccount.bank, accountByIban);
  const groups = groupByAccount(
    { ...parsed, rows: parsed.rows.filter((r) => accountByIban.has(r.iban)) },
    accountByIban,
  );
  for (const { rows } of groups.values()) {
    preReasons.push(...findInFileKeyConflicts(overlapCandidates(rows)));
  }
  if (preReasons.length > 0) {
    return recordRejection(ctx, facts, preReasons);
  }

  // From here on the checks depend on stored history, so they run inside the
  // write transaction with every involved account locked.
  const transactionId = await beginTransaction(dataApiClient, dataApiConfig);
  try {
    await executeStatement(
      dataApiClient,
      dataApiConfig,
      `SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`,
      {},
      transactionId,
    );
    // Id order keeps two multi-account files from deadlocking each other.
    const lockIds = [...new Set([uploadAccount.id, ...groups.keys()])];
    const { rows: lockedRows } = await executeStatement(
      dataApiClient,
      dataApiConfig,
      `SELECT id, bank, iban, currency, opened_on, opening_balance_minor_units
         FROM accounts
        WHERE id IN (SELECT jsonb_array_elements_text(CAST(:ids AS jsonb)))
        ORDER BY id FOR UPDATE`,
      { ids: JSON.stringify(lockIds) },
      transactionId,
    );
    const lockedById = new Map(
      (lockedRows as unknown as AccountRecord[]).map((a) => [a.id, a]),
    );

    // A concurrent redelivery of this same object may have committed while we
    // waited for the lock.
    const committedMeanwhile = await findRecordedOutcome(ctx, key, transactionId);
    if (committedMeanwhile) {
      await rollbackTransaction(dataApiClient, dataApiConfig, transactionId);
      return committedMeanwhile;
    }

    const reasons: ValidationReason[] = [];

    const { rows: duplicateRows } = await executeStatement(
      dataApiClient,
      dataApiConfig,
      `SELECT id, processed_at FROM statement_files
        WHERE upload_account_id = :accountId AND sha256 = :sha256 AND status = 'approved'`,
      { accountId: uploadAccount.id, sha256 },
      transactionId,
    );
    const duplicate = duplicateRows[0] as { id: string; processed_at: string } | undefined;
    if (duplicate) {
      reasons.push({
        code: 'duplicate-file',
        message: `Duplicate of an earlier import (file ${duplicate.id}, processed ${String(duplicate.processed_at)})`,
      });
    }

    const warningsByAccount: Record<string, ValidationReason[]> = {};
    const segmentByAccount = new Map<string, Segment>();
    const fileId = newId();
    for (const [id, { account, rows }] of groups) {
      reasons.push(
        ...(await findOverlapConflicts(
          dataApiClient,
          dataApiConfig,
          transactionId,
          id,
          overlapCandidates(rows),
        )),
      );

      const declared = parsed.declaredPeriods.find((p) => p.iban === account.iban);
      const bounds = activityBounds(rows);
      const accountBalances = balances.get(account.iban);
      const segment: Segment = {
        fileId,
        declaredFrom: declared?.from ?? null,
        declaredTo: declared?.to ?? null,
        activityFrom: bounds.from,
        activityTo: bounds.to,
        openingBalanceMinorUnits: accountBalances?.openingBalanceMinorUnits ?? null,
        closingBalanceMinorUnits: accountBalances?.closingBalanceMinorUnits ?? null,
      };
      segmentByAccount.set(id, segment);

      const locked = lockedById.get(id) as AccountRecord;
      const coverageAccount: CoverageAccount = {
        currency: locked.currency,
        openedOn: String(locked.opened_on),
        openingBalanceMinorUnits: locked.opening_balance_minor_units,
      };
      warningsByAccount[id] = continuityWarnings(
        coverageAccount,
        await loadSegments(dataApiClient, dataApiConfig, id, transactionId),
        segment,
      );
    }

    if (reasons.length > 0) {
      const { fileId: rejectedId, inserted } = await insertRejected(
        ctx,
        facts,
        reasons,
        transactionId,
      );
      await commitTransaction(dataApiClient, dataApiConfig, transactionId);
      if (!inserted) {
        const recorded = await findRecordedOutcome(ctx, key);
        if (recorded) return recorded;
      }
      return {
        fileId: rejectedId,
        status: 'rejected',
        reasons,
        warningsByAccount: {},
        redelivered: false,
      };
    }

    await executeStatement(
      dataApiClient,
      dataApiConfig,
      `INSERT INTO statement_files
         (id, upload_account_id, uploaded_by, bank, format_version, sha256, s3_key, status)
       VALUES (:id, :uploadAccountId, :uploadedBy, :bank, :formatVersion, :sha256, :s3Key, 'approved')`,
      {
        id: fileId,
        uploadAccountId: facts.uploadAccountId,
        uploadedBy: facts.uploadedBy,
        bank: facts.bank,
        formatVersion: parsed.formatVersion,
        sha256,
        s3Key: key,
      },
      transactionId,
    );

    const rawIdByRow = new Map<number, string>();
    await insertRawRows(
      dataApiClient,
      dataApiConfig,
      transactionId,
      parsed.rows.map((row) => {
        const id = newId();
        rawIdByRow.set(row.rowNumber, id);
        return {
          id,
          fileId,
          accountId: (accountByIban.get(row.iban) as AccountRecord).id,
          rowNumber: row.rowNumber,
          bank: uploadAccount.bank,
          formatVersion: parsed.formatVersion,
          bankTransactionId: row.bankTransactionId,
          payload: row.payload,
        };
      }),
    );

    const derivationFiles: DerivationFile[] = [...groups.values()].map(
      ({ account, rows }) => ({
        bank: uploadAccount.bank,
        accountId: account.id,
        accountIban: account.iban,
        rows: rows.map((row) => ({
          rawRowId: rawIdByRow.get(row.rowNumber) as string,
          rowNumber: row.rowNumber,
          payload: row.payload,
        })),
      }),
    );
    const { newTransactionsByAccount } = await writeDerivation(
      dataApiClient,
      dataApiConfig,
      transactionId,
      deriveTransactions(derivationFiles),
    );

    for (const [id, segment] of segmentByAccount) {
      await executeStatement(
        dataApiClient,
        dataApiConfig,
        `INSERT INTO statement_file_accounts
           (file_id, account_id, declared_from, declared_to, activity_from, activity_to,
            opening_balance_minor_units, closing_balance_minor_units, new_transaction_count, warnings)
         VALUES (:fileId, :accountId, :declaredFrom, :declaredTo, :activityFrom, :activityTo,
                 :opening, :closing, :newCount, CAST(:warnings AS jsonb))`,
        {
          fileId,
          accountId: id,
          declaredFrom: nullableDate(segment.declaredFrom),
          declaredTo: nullableDate(segment.declaredTo),
          activityFrom: nullableDate(segment.activityFrom),
          activityTo: nullableDate(segment.activityTo),
          opening: segment.openingBalanceMinorUnits,
          closing: segment.closingBalanceMinorUnits,
          newCount: newTransactionsByAccount.get(id) ?? 0,
          warnings: JSON.stringify(warningsByAccount[id] ?? []),
        },
        transactionId,
      );
    }

    await commitTransaction(dataApiClient, dataApiConfig, transactionId);
    return { fileId, status: 'approved', reasons: [], warningsByAccount, redelivered: false };
  } catch (error) {
    await rollbackQuietly(ctx, transactionId);
    // Safety net: the partial unique index closes the race where the same file
    // is approved twice; the loser is a duplicate rejection, not an error.
    if (error instanceof Error && error.message.includes(DUPLICATE_APPROVED_INDEX)) {
      return recordRejection(ctx, facts, [
        { code: 'duplicate-file', message: 'Duplicate of an earlier import' },
      ]);
    }
    throw error;
  }
}

function nullableDate(value: string | null) {
  return value === null ? null : dateParameter(value);
}
