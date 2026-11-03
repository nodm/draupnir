// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { S3Client } from '@aws-sdk/client-s3';
import {
  applyMigrationsForTest,
  createPgliteDataApiClient,
  type DataApiConfig,
} from 'shared';
import {
  MissingUploadAccountError,
  OversizedStatementFileError,
  processStatementFile,
  type StatementOutcome,
} from './processStatementFile';

const config: DataApiConfig = { resourceArn: 'a', secretArn: 'a', database: 'd' };
const fixture = (name: string) =>
  readFileSync(join(__dirname, 'parsers/__fixtures__', name), 'utf8');
const SEB = fixture('seb.csv');
const REVOLUT = fixture('revolut.csv');
const REVOLUT_STATES = fixture('revolut-states.csv');
const MONOBANK = fixture('monobank.csv');
const REVOLUT_HEADER = REVOLUT.split('\n')[0] as string;

const IBAN_A = 'LT100000000000000001';
const IBAN_B = 'LT100000000000000002';
const REVOLUT_IBAN = 'LT100000000000000077';
const MONO_IBAN = 'UA100000000000000077';

function fakeS3(contents: string, contentLength?: number): S3Client {
  const bytes = Buffer.from(contents, 'utf8');
  return {
    send: async () => ({
      Body: { transformToByteArray: async () => new Uint8Array(bytes) },
      ContentLength: contentLength ?? bytes.length,
    }),
  } as unknown as S3Client;
}

describe('processStatementFile', () => {
  let db: PGlite;
  let counter = 0;
  let sqlLog: string[] = [];

  beforeAll(async () => {
    db = new PGlite();
    await applyMigrationsForTest(db);
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.exec(
      'TRUNCATE transaction_sources, transactions, raw_rows, statement_file_accounts, statement_files, account_members, accounts CASCADE',
    );
    sqlLog = [];
  });

  async function account(opts: {
    id: string;
    iban: string;
    bank?: string;
    currency?: string;
    owner?: string | null;
    viewer?: string;
    openedOn?: string;
    opening?: number;
  }) {
    await db.query(
      `INSERT INTO accounts (id, bank, iban, currency, display_name, opened_on, opening_balance_minor_units)
       VALUES ($1, $2, $3, $4, $1, $5, $6)`,
      [
        opts.id,
        opts.bank ?? 'seb',
        opts.iban,
        opts.currency ?? 'EUR',
        opts.openedOn ?? '2026-01-01',
        opts.opening ?? 0,
      ],
    );
    if (opts.owner !== null) {
      await db.query(
        `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [opts.id, opts.owner ?? 'user-1'],
      );
    }
    if (opts.viewer) {
      await db.query(
        `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'viewer')`,
        [opts.id, opts.viewer],
      );
    }
  }

  type Hook = (command: { constructor: { name: string }; input: Record<string, unknown> }) => void;

  function upload(
    contents: string,
    opts: { accountId: string; sub?: string; key?: string; hook?: Hook; size?: number } ,
  ): Promise<StatementOutcome> {
    counter += 1;
    const key =
      opts.key ?? `uploads/${opts.sub ?? 'user-1'}/${opts.accountId}/${counter}.csv`;
    const real = createPgliteDataApiClient(db).client;
    const client = {
      send: async (command: Parameters<Hook>[0]) => {
        const sql = command.input['sql'];
        if (typeof sql === 'string') sqlLog.push(sql);
        opts.hook?.(command);
        return real.send(command as never);
      },
    } as unknown as typeof real;
    return processStatementFile(
      client,
      config,
      fakeS3(contents, opts.size),
      'bucket',
      key,
      opts.size ?? Buffer.byteLength(contents),
    );
  }

  const count = async (table: string) =>
    Number(
      (await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n,
    );

  const revolutRow = (
    started: string,
    completed: string,
    description: string,
    amount: string,
    balance: string,
  ) =>
    `Card Payment,Current,${started},${completed},${description},${amount},0.00,EUR,COMPLETED,${balance}`;

  describe('approved files', () => {
    it('writes the file, per-account record, raw rows, transactions and sources', async () => {
      await account({ id: 'R', iban: REVOLUT_IBAN, bank: 'revolut', opening: 1191 });

      const outcome = await upload(REVOLUT, { accountId: 'R' });

      expect(outcome).toMatchObject({ status: 'approved', reasons: [], redelivered: false });
      const file = (await db.query<Record<string, unknown>>('SELECT * FROM statement_files')).rows[0];
      expect(file).toMatchObject({
        status: 'approved',
        bank: 'revolut',
        format_version: 'revolut-v1',
        uploaded_by: 'user-1',
        upload_account_id: 'R',
      });
      expect(file?.['sha256']).toMatch(/^[0-9a-f]{64}$/);
      const perAccount = (await db.query<Record<string, unknown>>('SELECT * FROM statement_file_accounts')).rows[0];
      expect(perAccount).toMatchObject({
        account_id: 'R',
        new_transaction_count: 2,
        warnings: [],
      });
      expect(Number(perAccount?.['opening_balance_minor_units'])).toBe(1191);
      expect(Number(perAccount?.['closing_balance_minor_units'])).toBe(1133);
      expect(await count('raw_rows')).toBe(2);
      expect(await count('transactions')).toBe(2);
      expect(await count('transaction_sources')).toBe(2);
    });

    it('keeps PENDING and non-Current rows raw-only', async () => {
      await account({ id: 'R', iban: REVOLUT_IBAN, bank: 'revolut', opening: 1191 });

      await upload(REVOLUT_STATES, { accountId: 'R' });

      expect(await count('raw_rows')).toBe(4);
      expect(await count('transactions')).toBe(2);
    });

    it('stores raw values exactly as exported', async () => {
      await account({ id: 'M', iban: MONO_IBAN, bank: 'monobank', currency: 'UAH', opening: 375158 + 0 });

      const outcome = await upload(MONOBANK, { accountId: 'M' });

      expect(outcome.status).toBe('approved');
      const { rows } = await db.query<{ payload: Record<string, string> }>(
        'SELECT payload FROM raw_rows ORDER BY row_number LIMIT 1',
      );
      expect(rows[0]?.payload['Exchange rate']).toBe('—');
      expect(rows[0]?.payload['Balance']).toBe('2531.58');
    });

    it('resolves each row of a multi-account SEB file to its own account', async () => {
      await account({ id: 'A', iban: IBAN_A });
      await account({ id: 'B', iban: IBAN_B });

      // Uploaded with A selected; most rows belong to B.
      const outcome = await upload(SEB, { accountId: 'A' });

      expect(outcome.status).toBe('approved');
      const byAccount = (
        await db.query<{ account_id: string; n: string }>(
          'SELECT account_id, count(*) AS n FROM transactions GROUP BY account_id ORDER BY account_id',
        )
      ).rows.map((r) => [r.account_id, Number(r.n)]);
      expect(byAccount).toEqual([
        ['A', 1],
        ['B', 5],
      ]);
      const perAccount = (
        await db.query<{ account_id: string; declared_from: string }>(
          'SELECT account_id, declared_from::text AS declared_from FROM statement_file_accounts ORDER BY account_id',
        )
      ).rows;
      expect(perAccount.map((r) => r.account_id)).toEqual(['A', 'B']);
      expect(perAccount[0]?.declared_from).toBe('2026-08-29');
      const rawAccounts = (
        await db.query<{ account_id: string }>('SELECT DISTINCT account_id FROM raw_rows ORDER BY 1')
      ).rows.map((r) => r.account_id);
      expect(rawAccounts).toEqual(['A', 'B']);
    });

    it('commits everything in one Data API transaction, locking accounts in id order first', async () => {
      await account({ id: 'A', iban: IBAN_A });
      await account({ id: 'B', iban: IBAN_B });

      await upload(SEB, { accountId: 'B' });

      const joined = sqlLog.join('\n');
      expect(joined).toContain("SET LOCAL lock_timeout = '30s'");
      expect(joined).toMatch(/ORDER BY id FOR UPDATE/);
      expect(joined.indexOf('FOR UPDATE')).toBeLessThan(
        joined.indexOf('INSERT INTO statement_files'),
      );
    });
  });

  describe('rejections', () => {
    it('records a validation failure as rejected, writes no rows, and does not throw', async () => {
      await account({ id: 'R', iban: REVOLUT_IBAN, bank: 'revolut' });
      const bad = `${REVOLUT_HEADER}\nCard Payment,Current,x,y,Lidl,abc,0.00,EUR,COMPLETED,1.00\n`;

      const outcome = await upload(bad, { accountId: 'R' });

      expect(outcome.status).toBe('rejected');
      expect(outcome.reasons.length).toBeGreaterThan(0);
      const file = (await db.query<Record<string, unknown>>('SELECT * FROM statement_files')).rows[0];
      expect(file?.['status']).toBe('rejected');
      expect(JSON.stringify(file?.['rejection_reasons'])).toContain('Row 1');
      expect(await count('raw_rows')).toBe(0);
      expect(await count('transactions')).toBe(0);
      expect(await count('statement_file_accounts')).toBe(0);
    });

    it('rejects an unrecognized format', async () => {
      await account({ id: 'R', iban: REVOLUT_IBAN, bank: 'revolut' });

      const outcome = await upload('foo,bar\n1,2\n', { accountId: 'R' });

      expect(outcome.reasons[0]?.code).toBe('unrecognized-format');
    });

    it('rejects a currency mismatch naming the row', async () => {
      await account({ id: 'R', iban: REVOLUT_IBAN, bank: 'revolut', currency: 'USD', opening: 1191 });

      const outcome = await upload(REVOLUT, { accountId: 'R' });

      expect(outcome.status).toBe('rejected');
      expect(outcome.reasons[0]).toMatchObject({ code: 'currency-mismatch', row: 1 });
      expect(await count('transactions')).toBe(0);
    });

    it('rejects the whole file when a row iban matches no account the uploader owns', async () => {
      await account({ id: 'A', iban: IBAN_A });
      await account({ id: 'B', iban: IBAN_B, owner: 'someone-else' });

      const outcome = await upload(SEB, { accountId: 'A' });

      expect(outcome.status).toBe('rejected');
      expect(outcome.reasons.map((r) => r.message).join(' ')).toContain(IBAN_B);
      expect(await count('raw_rows')).toBe(0);
      expect(await count('transactions')).toBe(0);
      expect(await count('accounts')).toBe(2);
    });

    it('rejects an uploader who is only a viewer of the selected account', async () => {
      await account({ id: 'R', iban: REVOLUT_IBAN, bank: 'revolut', viewer: 'viewer-1' });

      const outcome = await upload(REVOLUT, { accountId: 'R', sub: 'viewer-1' });

      expect(outcome.reasons[0]?.code).toBe('not-owner');
      expect(await count('transactions')).toBe(0);
    });

    it('rejects a re-upload of the same bytes for the same account, naming the earlier import', async () => {
      await account({ id: 'R', iban: REVOLUT_IBAN, bank: 'revolut', opening: 1191 });
      const first = await upload(REVOLUT, { accountId: 'R' });

      const second = await upload(REVOLUT, { accountId: 'R' });

      expect(second.status).toBe('rejected');
      expect(second.reasons[0]?.code).toBe('duplicate-file');
      expect(second.reasons[0]?.message).toContain(first.fileId);
      expect(await count('raw_rows')).toBe(2);
      expect(await count('statement_files')).toBe(2);
    });

    it('does not treat the same bytes for a different account as a duplicate', async () => {
      await account({ id: 'M1', iban: MONO_IBAN, bank: 'monobank', currency: 'UAH', opening: 375158 });
      await account({ id: 'M2', iban: 'UA100000000000000078', bank: 'monobank', currency: 'UAH', opening: 375158 });
      await upload(MONOBANK, { accountId: 'M1' });

      const second = await upload(MONOBANK, { accountId: 'M2' });

      expect(second.status).toBe('approved');
    });

    it('maps the partial-unique-index race to a duplicate rejection', async () => {
      await account({ id: 'R', iban: REVOLUT_IBAN, bank: 'revolut', opening: 1191 });
      await upload(REVOLUT, { accountId: 'R' });

      // Hide the duplicate pre-check so the insert itself hits the index.
      const outcome = await upload(REVOLUT, {
        accountId: 'R',
        hook: (command) => {
          const sql = command.input['sql'];
          if (typeof sql === 'string' && sql.includes("status = 'approved'")) {
            command.input['sql'] = sql.replace("status = 'approved'", "status = 'nonexistent'");
          }
        },
      });

      expect(outcome.status).toBe('rejected');
      expect(outcome.reasons[0]?.code).toBe('duplicate-file');
      expect(await count('raw_rows')).toBe(2);
    });
  });

  describe('overlap with stored history', () => {
    const file1 = [
      REVOLUT_HEADER,
      revolutRow('2026-01-02 10:00:00', '2026-01-02 10:00:00', 'Alpha', '-1.00', '9.00'),
      revolutRow('2026-01-03 10:00:00', '2026-01-03 10:00:00', 'Bravo', '-1.00', '8.00'),
    ].join('\n');
    const file2 = [
      REVOLUT_HEADER,
      revolutRow('2026-01-03 10:00:00', '2026-01-03 10:00:00', 'Bravo', '-1.00', '8.00'),
      revolutRow('2026-01-04 10:00:00', '2026-01-04 10:00:00', 'Charlie', '-1.00', '7.00'),
    ].join('\n');

    it('adds a source to an overlapping transaction instead of duplicating it', async () => {
      await account({ id: 'R', iban: REVOLUT_IBAN, bank: 'revolut', opening: 1000 });
      await upload(file1, { accountId: 'R' });

      const outcome = await upload(file2, { accountId: 'R' });

      expect(outcome.status).toBe('approved');
      expect(await count('transactions')).toBe(3);
      expect(await count('raw_rows')).toBe(4);
      const sources = (
        await db.query<{ n: string }>(
          `SELECT count(*) AS n FROM transaction_sources s JOIN transactions t ON t.id = s.transaction_id
            WHERE t.description = 'bravo'`,
        )
      ).rows[0];
      expect(Number(sources?.n)).toBe(2);
      const second = (
        await db.query<{ new_transaction_count: number }>(
          `SELECT new_transaction_count FROM statement_file_accounts WHERE file_id = $1`,
          [outcome.fileId],
        )
      ).rows[0];
      expect(second?.new_transaction_count).toBe(1);
    });

    it('rejects an overlapping row that conflicts with the stored transaction', async () => {
      await account({ id: 'R', iban: REVOLUT_IBAN, bank: 'revolut', opening: 1000 });
      await upload(file1, { accountId: 'R' });
      const conflicting = [
        REVOLUT_HEADER,
        revolutRow('2026-01-03 10:00:00', '2026-01-03 10:00:00', 'Bravo', '-1.00', '7.50'),
      ].join('\n');

      const outcome = await upload(conflicting, { accountId: 'R' });

      expect(outcome.status).toBe('rejected');
      expect(outcome.reasons[0]).toMatchObject({ code: 'conflicting-overlap', row: 1 });
      expect(await count('transactions')).toBe(2);
    });

    it('approves exactly one of two SEB files carrying the same provider id with different amounts', async () => {
      await account({ id: 'A', iban: IBAN_A });
      await account({ id: 'B', iban: IBAN_B });
      const altered = SEB.replace('"EUR";50,00;"VARDENIS', '"EUR";51,00;"VARDENIS');
      expect(altered).not.toBe(SEB);

      const first = await upload(SEB, { accountId: 'A' });
      const second = await upload(altered, { accountId: 'A' });

      expect([first.status, second.status].sort()).toEqual(['approved', 'rejected']);
      expect(second.reasons[0]?.code).toBe('conflicting-overlap');
    });
  });

  describe('continuity warnings', () => {
    it('approves an out-of-order file with a gap warning recorded on its account record', async () => {
      await account({ id: 'R', iban: REVOLUT_IBAN, bank: 'revolut', opening: 1000 });
      const march = [
        REVOLUT_HEADER,
        revolutRow('2026-03-02 10:00:00', '2026-03-02 10:00:00', 'March', '-1.00', '16.00'),
      ].join('\n');
      await upload(march, { accountId: 'R' });
      // opening 10.00 closing 9.00 ≠ March opening 17.00
      const january = [
        REVOLUT_HEADER,
        revolutRow('2026-01-02 10:00:00', '2026-01-02 10:00:00', 'January', '-1.00', '9.00'),
      ].join('\n');

      const outcome = await upload(january, { accountId: 'R' });

      expect(outcome.status).toBe('approved');
      expect(outcome.warningsByAccount['R']?.map((w) => w.code)).toEqual(['gap-after']);
      const stored = (
        await db.query<{ warnings: { code: string }[] }>(
          'SELECT warnings FROM statement_file_accounts WHERE file_id = $1',
          [outcome.fileId],
        )
      ).rows[0];
      expect(stored?.warnings.map((w) => w.code)).toEqual(['gap-after']);
    });

    it('has no warning when the file connects to history and the opening', async () => {
      await account({ id: 'R', iban: REVOLUT_IBAN, bank: 'revolut', opening: 1000 });
      const jan = [
        REVOLUT_HEADER,
        revolutRow('2026-01-02 10:00:00', '2026-01-02 10:00:00', 'Jan', '-1.00', '9.00'),
      ].join('\n');
      const feb = [
        REVOLUT_HEADER,
        revolutRow('2026-02-02 10:00:00', '2026-02-02 10:00:00', 'Feb', '-1.00', '8.00'),
      ].join('\n');
      const first = await upload(jan, { accountId: 'R' });

      const second = await upload(feb, { accountId: 'R' });

      expect(first.warningsByAccount['R']).toEqual([]);
      expect(second.status).toBe('approved');
      expect(second.warningsByAccount['R']).toEqual([]);
    });

    it('warns when the first file does not match the account opening balance', async () => {
      await account({ id: 'R', iban: REVOLUT_IBAN, bank: 'revolut', opening: 5 });

      const outcome = await upload(REVOLUT, { accountId: 'R' });

      expect(outcome.status).toBe('approved');
      expect(outcome.warningsByAccount['R']?.map((w) => w.code)).toEqual(['gap-opening']);
    });
  });

  describe('redelivery and failure', () => {
    it('returns the recorded outcome for a redelivered object without creating a second record', async () => {
      await account({ id: 'R', iban: REVOLUT_IBAN, bank: 'revolut', opening: 1191 });
      const key = 'uploads/user-1/R/same-object.csv';
      const first = await upload(REVOLUT, { accountId: 'R', key });

      const again = await upload(REVOLUT, { accountId: 'R', key });

      expect(again).toMatchObject({ fileId: first.fileId, status: 'approved', redelivered: true });
      expect(await count('statement_files')).toBe(1);
      expect(await count('raw_rows')).toBe(2);
    });

    it('returns the recorded rejection for a redelivered rejected object', async () => {
      await account({ id: 'R', iban: REVOLUT_IBAN, bank: 'revolut' });
      const key = 'uploads/user-1/R/bad.csv';
      const first = await upload('foo,bar\n', { accountId: 'R', key });

      const again = await upload('foo,bar\n', { accountId: 'R', key });

      expect(again).toMatchObject({ fileId: first.fileId, status: 'rejected', redelivered: true });
      expect(again.reasons).toEqual(first.reasons);
      expect(await count('statement_files')).toBe(1);
    });

    it('leaves no partial rows when a write fails partway, and surfaces the error', async () => {
      await account({ id: 'R', iban: REVOLUT_IBAN, bank: 'revolut', opening: 1191 });

      await expect(
        upload(REVOLUT, {
          accountId: 'R',
          hook: (command) => {
            const sql = command.input['sql'];
            if (typeof sql === 'string' && sql.includes('INSERT INTO transactions')) {
              throw new Error('boom');
            }
          },
        }),
      ).rejects.toThrow('boom');

      expect(await count('statement_files')).toBe(0);
      expect(await count('raw_rows')).toBe(0);
      expect(await count('transactions')).toBe(0);
    });

    it('fails when the upload-selected account does not exist', async () => {
      await expect(upload(REVOLUT, { accountId: 'ghost' })).rejects.toBeInstanceOf(
        MissingUploadAccountError,
      );
    });

    it('rejects an oversized file from the event size before touching S3', async () => {
      await expect(
        upload('x', { accountId: 'R', size: 11 * 1024 * 1024 }),
      ).rejects.toBeInstanceOf(OversizedStatementFileError);
    });
  });
});
