import { createHash } from 'node:crypto';
import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import {
  boundOutcomeMessage,
  coveredPeriod,
  dateParameter,
  enqueueOutcome,
  executeStatement,
  getMemberRole,
  isOutcomeMessage,
  loadSegments,
  memberPredicate,
  recomputeAccountBalance,
  withCaller,
  type Bank,
  type CoverageAccount,
  type DataApiConfig,
  type Segment,
  type StatementOutcomeMessage,
} from 'shared';
import { deriveTransactions, type DerivationFile } from './derive';
import type { ParsedRow, ParsedStatement } from './parsers/types';
import { formatMinorUnits } from './dedupKey';
import { continuityReasons } from './validation/coverage';
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

export class OversizedStatementFileError extends Error {
  constructor(sizeBytes: number) {
    super(
      `Statement file is ${sizeBytes} bytes, exceeding the ${MAX_UPLOAD_SIZE_BYTES}-byte limit`,
    );
    this.name = 'OversizedStatementFileError';
  }
}

// Thrown from inside the write transaction so that every write and balance of
// the file rolls back; the file is then recorded as rejected.
class ClosingBalanceMismatchError extends Error {
  constructor(readonly reason: ValidationReason) {
    super(reason.message);
    this.name = 'ClosingBalanceMismatchError';
  }
}

export interface StatementOutcome {
  // Null for a rejection that couldn't be recorded: the uploader no longer owns
  // the upload account, so row-level security refuses the statement_files row.
  fileId: string | null;
  status: 'approved' | 'rejected';
  // Hard reasons; empty for an approved file.
  reasons: ValidationReason[];
  // Per account id; empty for a rejected file.
  warningsByAccount: Record<string, ValidationReason[]>;
  // True when this call only returned the outcome recorded by an earlier one.
  redelivered: boolean;
  // The message to publish for an outcome committed by this call. Recorded
  // outcomes also have an outbox row written in the same transaction, so the
  // publish is recoverable; null for a redelivery, whose row already exists.
  report: StatementOutcomeMessage | null;
}

// An uploader who isn't an owner of the upload account can't write a
// statement_files row (row-level security), so this rejection is reported but
// not recorded. It is deterministic, so a redelivery reaches the same outcome.
function unrecordedRejection(
  reasons: ValidationReason[],
  s3Key: string,
  sub: string,
): StatementOutcome {
  return {
    fileId: null,
    status: 'rejected',
    reasons,
    warningsByAccount: {},
    redelivered: false,
    // No statement_files row means no outbox row: this one is published
    // directly, and a redelivery reaches the same deterministic rejection.
    report: boundOutcomeMessage({
      fileId: null,
      s3Key,
      sub,
      status: 'rejected',
      reasons,
      warningsByAccount: {},
      newTransactionCount: 0,
      period: null,
    }),
  };
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
  // The uploader, taken from the S3 object key: every database access runs as
  // them, so row-level security applies to the worker like to any caller.
  sub: string;
}

// Runs `work` inside `transactionId` when one is open, else in its own
// transaction as the uploader.
function inCallerTransaction<T>(
  ctx: Context,
  transactionId: string | undefined,
  work: (transactionId: string) => Promise<T>,
): Promise<T> {
  return transactionId === undefined
    ? withCaller(ctx.client, ctx.config, ctx.sub, work)
    : work(transactionId);
}

function parseJsonColumn<T>(value: unknown, fallback: T): T {
  if (typeof value === 'string') return JSON.parse(value) as T;
  return (value as T | null | undefined) ?? fallback;
}

// Returns the outcome already committed for this S3 object, if any.
async function findRecordedOutcome(
  ctx: Context,
  key: string,
  transactionId?: string,
): Promise<StatementOutcome | null> {
  return inCallerTransaction(ctx, transactionId, (tx) =>
    readRecordedOutcome(ctx, key, tx),
  );
}

async function readRecordedOutcome(
  { client, config }: Context,
  key: string,
  transactionId: string,
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
    | {
        id: string;
        status: 'approved' | 'rejected';
        rejection_reasons: string | null;
      }
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
    for (const r of perAccount as unknown as {
      account_id: string;
      warnings: string;
    }[]) {
      warningsByAccount[r.account_id] = parseJsonColumn(r.warnings, []);
    }
  }
  return {
    fileId: file.id,
    status: file.status,
    reasons: parseJsonColumn(file.rejection_reasons, []),
    warningsByAccount,
    redelivered: true,
    report: null,
  };
}

// The outcome committed for this object, recovered from its outbox row. Works
// whatever the uploader's current membership is: the lookup is scoped to the
// uploader, not to the account. Nothing is republished here; the row already
// exists and the sweeper delivers it if the first publish was missed.
async function findOutcomeInOutbox(
  ctx: Context,
  key: string,
): Promise<StatementOutcome | null> {
  const { rows } = await inCallerTransaction(ctx, undefined, (tx) =>
    executeStatement(
      ctx.client,
      ctx.config,
      `SELECT CAST(draupnir.recorded_outcome(:key) AS text) AS payload`,
      { key },
      tx,
    ),
  );
  const raw = (rows[0] as { payload: string | null } | undefined)?.payload;
  if (!raw) return null;
  const message: unknown = JSON.parse(raw);
  if (!isOutcomeMessage(message)) return null;
  return {
    fileId: message.fileId,
    status: message.status,
    reasons: message.reasons,
    warningsByAccount: message.warningsByAccount,
    redelivered: true,
    report: null,
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
  transactionId: string,
): Promise<{
  fileId: string;
  inserted: boolean;
  report: StatementOutcomeMessage;
}> {
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
  const report = boundOutcomeMessage({
    fileId,
    s3Key: facts.s3Key,
    sub: facts.uploadedBy,
    status: 'rejected',
    reasons,
    warningsByAccount: {},
    newTransactionCount: 0,
    period: null,
  });
  const inserted = numberOfRecordsUpdated > 0;
  // Same transaction as the record: both commit or neither does.
  if (inserted) {
    await enqueueOutcome(client, config, transactionId, report);
  }
  return { fileId, inserted, report };
}

// Records a rejection in its own transaction and returns the outcome. If the
// object turns out to be recorded already, that recorded outcome wins.
async function recordRejection(
  ctx: Context,
  facts: FileFacts,
  reasons: ValidationReason[],
): Promise<StatementOutcome> {
  try {
    return await withCaller(
      ctx.client,
      ctx.config,
      ctx.sub,
      async (transactionId) => {
        const { fileId, inserted, report } = await insertRejected(
          ctx,
          facts,
          reasons,
          transactionId,
        );
        if (!inserted) {
          const recorded = await readRecordedOutcome(
            ctx,
            facts.s3Key,
            transactionId,
          );
          if (recorded) return recorded;
        }
        return {
          fileId,
          status: 'rejected' as const,
          reasons,
          warningsByAccount: {},
          redelivered: false,
          report,
        };
      },
    );
  } catch (error) {
    // The uploader's ownership can lapse between the early check and this
    // write; RLS then refuses the statement_files row. That is the same
    // unrecorded not-owner rejection, not an error that retries into the DLQ.
    if (isStatementFilesPolicyViolation(error)) {
      return unrecordedRejection(
        [
          {
            code: 'not-owner',
            message:
              'The uploader is no longer an owner of the selected account',
          },
        ],
        facts.s3Key,
        ctx.sub,
      );
    }
    throw error;
  }
}

function isStatementFilesPolicyViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes(
      'violates row-level security policy for table "statement_files"',
    )
  );
}

async function resolveRowAccounts(
  ctx: Context,
  uploaderSub: string,
  parsed: ParsedStatement,
): Promise<Map<string, AccountRecord>> {
  const ibans = [...new Set(parsed.rows.map((row) => row.iban))];
  const { rows } = await withCaller(
    ctx.client,
    ctx.config,
    ctx.sub,
    (transactionId) =>
      executeStatement(
        ctx.client,
        ctx.config,
        `SELECT a.id, a.bank, a.iban, a.currency, a.opened_on, a.opening_balance_minor_units
       FROM accounts a
      WHERE a.iban IN (SELECT jsonb_array_elements_text(CAST(:ibans AS jsonb)))
        AND ${memberPredicate('a', 'id', 'owner')}`,
        { ibans: JSON.stringify(ibans), sub: uploaderSub },
        transactionId,
      ),
  );
  return new Map(
    (rows as unknown as AccountRecord[]).map((account) => [
      account.iban,
      account,
    ]),
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
    // Every row counts, including raw-only ones (e.g. a PENDING Revolut row):
    // they are stored too, so a foreign-currency row can't slip in.
    if (row.currency !== account.currency) {
      reasons.push({
        code: 'currency-mismatch',
        row: row.rowNumber,
        message: `Row ${row.rowNumber}: currency ${row.currency} differs from the account's ${account.currency}`,
      });
    }
  }
  return reasons;
}

// A raw payload this large can't be sent as one Data API parameter set (4 MiB
// request cap), so a file carrying one is rejected up front rather than failing
// as an unexpected error and retrying to the DLQ.
const MAX_ROW_PAYLOAD_BYTES = 1024 * 1024;

function oversizedRowReasons(parsed: ParsedStatement): ValidationReason[] {
  return parsed.rows
    .filter(
      (row) =>
        Buffer.byteLength(JSON.stringify(row.payload), 'utf8') >
        MAX_ROW_PAYLOAD_BYTES,
    )
    .map((row) => ({
      code: 'row-too-large',
      row: row.rowNumber,
      message: `Row ${row.rowNumber} is larger than ${MAX_ROW_PAYLOAD_BYTES} bytes`,
    }));
}

function groupByAccount(
  parsed: ParsedStatement,
  accountByIban: Map<string, AccountRecord>,
): Map<string, { account: AccountRecord; rows: ParsedRow[] }> {
  const groups = new Map<
    string,
    { account: AccountRecord; rows: ParsedRow[] }
  >();
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
    row.normalized
      ? [{ rowNumber: row.rowNumber, normalized: row.normalized }]
      : [],
  );
}

function activityBounds(rows: readonly ParsedRow[]): {
  from: string | null;
  to: string | null;
} {
  const dates = rows.flatMap((r) =>
    r.normalized ? [r.normalized.postedDate] : [],
  );
  if (dates.length === 0) return { from: null, to: null };
  return {
    from: dates.reduce((a, b) => (a < b ? a : b)),
    to: dates.reduce((a, b) => (a > b ? a : b)),
  };
}

export async function processStatementFile(
  dataApiClient: RDSDataClient,
  dataApiConfig: DataApiConfig,
  s3Client: S3Client,
  bucket: string,
  key: string,
  objectSizeBytes: number,
): Promise<StatementOutcome> {
  if (objectSizeBytes > MAX_UPLOAD_SIZE_BYTES) {
    throw new OversizedStatementFileError(objectSizeBytes);
  }

  // Only the presigned-URL endpoint issues keys, and it checked owner
  // membership first, so the `sub` in the key is the identity the worker acts as.
  const { uploaderSub, accountId } = parseObjectKey(key);
  const ctx: Context = {
    client: dataApiClient,
    config: dataApiConfig,
    sub: uploaderSub,
  };

  // A redelivered message for an object whose outcome is already committed
  // returns that outcome — it must not be validated again, or the file would
  // be rejected as a duplicate of itself.
  const alreadyProcessed = await findRecordedOutcome(ctx, key);
  if (alreadyProcessed) return alreadyProcessed;
  // Row-level security hides an approved file from an uploader who has since
  // left the account, so the lookup above misses it. Without this one, the
  // redelivery would be judged "not an owner" and reported as a rejection while
  // the committed approval is still waiting to be published.
  const fromOutbox = await findOutcomeInOutbox(ctx, key);
  if (fromOutbox) return fromOutbox;

  const { rows: accountRows } = await withCaller(
    dataApiClient,
    dataApiConfig,
    uploaderSub,
    (transactionId) =>
      executeStatement(
        dataApiClient,
        dataApiConfig,
        'SELECT id, bank, iban, currency FROM accounts WHERE id = :accountId',
        { accountId },
        transactionId,
      ),
  );
  // RLS hides an account from a caller who isn't a member, so "the uploader was
  // removed" and "the account is gone" look the same here (as at the
  // presigned-URL endpoint). Both are an acknowledged, unrecorded not-owner
  // rejection, never a retry that would end in the DLQ.
  if (accountRows.length === 0) {
    return unrecordedRejection(
      [
        {
          code: 'not-owner',
          message:
            'The uploader is not an owner of the selected account, or it no longer exists',
        },
      ],
      key,
      uploaderSub,
    );
  }
  const uploadAccount = accountRows[0] as unknown as AccountRecord;

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
  if (
    (await getMemberRole(
      dataApiClient,
      dataApiConfig,
      accountId,
      uploaderSub,
    )) !== 'owner'
  ) {
    return unrecordedRejection(
      [
        {
          code: 'not-owner',
          message: 'The uploader is not an owner of the selected account',
        },
      ],
      key,
      uploaderSub,
    );
  }

  // Everything that depends only on the file: format, every row, the chain.
  const validation = validateStatementFile(
    uploadAccount.bank,
    fileContents,
    uploadAccount.iban,
  );
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
  const preReasons = [
    ...oversizedRowReasons(parsed),
    ...accountReasons(parsed, uploadAccount.bank, accountByIban),
  ];
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
  try {
    return await withCaller(
      dataApiClient,
      dataApiConfig,
      uploaderSub,
      async (transactionId) => {
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
        const committedMeanwhile = await findRecordedOutcome(
          ctx,
          key,
          transactionId,
        );
        if (committedMeanwhile) {
          return committedMeanwhile;
        }

        const reasons: ValidationReason[] = [];

        // Ownership was checked before this transaction, so re-check it here and
        // hold a share lock on the owner rows until commit. `removeMember` and
        // `changeMemberRole` lock a membership with FOR UPDATE, so a revocation
        // either finished before this read (and is seen) or waits for this commit.
        const { rows: ownerRows } = await executeStatement(
          dataApiClient,
          dataApiConfig,
          `SELECT account_id FROM account_members
        WHERE user_id = :sub AND role = 'owner'
          AND account_id IN (SELECT jsonb_array_elements_text(CAST(:ids AS jsonb)))
        ORDER BY account_id FOR SHARE`,
          { sub: uploaderSub, ids: JSON.stringify(lockIds) },
          transactionId,
        );
        const stillOwned = new Set(
          (ownerRows as unknown as { account_id: string }[]).map(
            (r) => r.account_id,
          ),
        );
        for (const id of lockIds) {
          if (!stillOwned.has(id)) {
            reasons.push({
              code: 'not-owner',
              message: `The uploader is no longer an owner of account ${lockedById.get(id)?.iban ?? id}`,
            });
          }
        }

        const { rows: duplicateRows } = await executeStatement(
          dataApiClient,
          dataApiConfig,
          `SELECT id, processed_at FROM statement_files
        WHERE upload_account_id = :accountId AND sha256 = :sha256 AND status = 'approved'`,
          { accountId: uploadAccount.id, sha256 },
          transactionId,
        );
        const duplicate = duplicateRows[0] as
          | { id: string; processed_at: string }
          | undefined;
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

          const declared = parsed.declaredPeriods.find(
            (p) => p.iban === account.iban,
          );
          const bounds = activityBounds(rows);
          const accountBalances = balances.get(account.iban);
          const segment: Segment = {
            fileId,
            declaredFrom: declared?.from ?? null,
            declaredTo: declared?.to ?? null,
            activityFrom: bounds.from,
            activityTo: bounds.to,
            openingBalanceMinorUnits:
              accountBalances?.openingBalanceMinorUnits ?? null,
            closingBalanceMinorUnits:
              accountBalances?.closingBalanceMinorUnits ?? null,
          };
          segmentByAccount.set(id, segment);

          // Missing only when ownership was lost since resolution (RLS hides the
          // account from FOR UPDATE); a not-owner reason was already recorded.
          const locked = lockedById.get(id);
          if (!locked) continue;
          const coverageAccount: CoverageAccount = {
            currency: locked.currency,
            openedOn: String(locked.opened_on),
            openingBalanceMinorUnits: locked.opening_balance_minor_units,
          };
          // A gap against stored history rejects the file: the stored balance
          // is only meaningful while history is continuous.
          reasons.push(
            ...continuityReasons(
              coverageAccount,
              await loadSegments(
                dataApiClient,
                dataApiConfig,
                id,
                transactionId,
              ),
              segment,
            ),
          );
          warningsByAccount[id] = [];
        }

        if (reasons.length > 0) {
          if (!stillOwned.has(uploadAccount.id)) {
            return unrecordedRejection(reasons, key, uploaderSub);
          }
          const {
            fileId: rejectedId,
            inserted,
            report,
          } = await insertRejected(ctx, facts, reasons, transactionId);
          if (!inserted) {
            const recorded = await findRecordedOutcome(ctx, key, transactionId);
            if (recorded) return recorded;
          }
          return {
            fileId: rejectedId,
            status: 'rejected' as const,
            reasons,
            warningsByAccount: {},
            redelivered: false,
            report,
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

        // The balance is recomputed from everything now stored, then checked
        // against the bank's own closing balance where the format has one.
        // Segments are written above, so the reconciled flag sees this file.
        for (const [id, segment] of segmentByAccount) {
          await recomputeAccountBalance(
            dataApiClient,
            dataApiConfig,
            transactionId,
            id,
          );
          if (segment.closingBalanceMinorUnits === null) continue;
          const { rows: lastRows } = await executeStatement(
            dataApiClient,
            dataApiConfig,
            `SELECT t.running_balance_minor_units
               FROM transactions t
               JOIN transaction_sources s ON s.transaction_id = t.id AND s.account_id = t.account_id
               JOIN raw_rows r ON r.id = s.raw_row_id AND r.file_id = :fileId
              WHERE t.account_id = :accountId
              ORDER BY t.occurred_at DESC, t.source_seq DESC, t.dedup_key DESC, t.id DESC
              LIMIT 1`,
            { fileId, accountId: id },
            transactionId,
          );
          const computed = (
            lastRows[0] as { running_balance_minor_units: number } | undefined
          )?.running_balance_minor_units;
          if (
            computed !== undefined &&
            computed !== segment.closingBalanceMinorUnits
          ) {
            const currency = (lockedById.get(id) as AccountRecord).currency;
            const money = (v: number) =>
              `${formatMinorUnits(v, currency)} ${currency}`;
            throw new ClosingBalanceMismatchError({
              code: 'closing-balance-mismatch',
              message: `The file's closing balance is ${money(segment.closingBalanceMinorUnits)}, but the account's balance after the file's last transaction is ${money(computed)} (opening balance plus the stored history plus this file)`,
            });
          }
        }

        const report = boundOutcomeMessage({
          fileId,
          s3Key: key,
          sub: uploaderSub,
          status: 'approved',
          reasons: [],
          warningsByAccount,
          newTransactionCount: [...newTransactionsByAccount.values()].reduce(
            (sum, count) => sum + count,
            0,
          ),
          period: coveredPeriod(
            [...segmentByAccount.values()].map((segment) => ({
              from: segment.declaredFrom ?? segment.activityFrom,
              to: segment.declaredTo ?? segment.activityTo,
            })),
          ),
        });
        // Same transaction as the approval: the outcome cannot commit without
        // its outbox row, and a failed publish later cannot lose it.
        await enqueueOutcome(
          dataApiClient,
          dataApiConfig,
          transactionId,
          report,
        );

        return {
          fileId,
          status: 'approved' as const,
          reasons: [],
          warningsByAccount,
          redelivered: false,
          report,
        };
      },
    );
  } catch (error) {
    // Everything the file wrote was rolled back with the transaction.
    if (error instanceof ClosingBalanceMismatchError) {
      return recordRejection(ctx, facts, [error.reason]);
    }
    // Safety net: the partial unique index closes the race where the same file
    // is approved twice; the loser is a duplicate rejection, not an error.
    if (
      error instanceof Error &&
      error.message.includes(DUPLICATE_APPROVED_INDEX)
    ) {
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
