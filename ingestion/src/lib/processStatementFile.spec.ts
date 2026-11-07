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
  OversizedStatementFileError,
  processStatementFile,
  type StatementOutcome,
} from './processStatementFile';

const config: DataApiConfig = {
  resourceArn: 'a',
  secretArn: 'a',
  database: 'd',
};
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
      'TRUNCATE statement_outcome_outbox, transaction_sources, transactions, raw_rows, statement_file_accounts, statement_files, account_members, accounts CASCADE',
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
        // The SEB fixture declares 2026-08-29; a first file only connects to an
        // account opened on or before its declared start.
        opts.openedOn ??
          ((opts.bank ?? 'seb') === 'seb' ? '2026-08-29' : '2026-01-01'),
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

  type Hook = (command: {
    constructor: { name: string };
    input: Record<string, unknown>;
  }) => void | Promise<void>;

  function upload(
    contents: string,
    opts: {
      accountId: string;
      sub?: string;
      key?: string;
      hook?: Hook;
      size?: number;
    },
  ): Promise<StatementOutcome> {
    counter += 1;
    const key =
      opts.key ??
      `uploads/${opts.sub ?? 'user-1'}/${opts.accountId}/${counter}.csv`;
    const real = createPgliteDataApiClient(db, { role: 'draupnir_app' }).client;
    const client = {
      send: async (command: Parameters<Hook>[0]) => {
        const sql = command.input['sql'];
        if (typeof sql === 'string') sqlLog.push(sql);
        await opts.hook?.(command);
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
      (await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`))
        .rows[0]?.n,
    );

  const revolutRow = (
    started: string,
    completed: string,
    description: string,
    amount: string,
    balance: string,
    fee = '0.00',
  ) =>
    `Card Payment,Current,${started},${completed},${description},${amount},${fee},EUR,COMPLETED,${balance}`;

  describe('approved files', () => {
    it('writes the file, per-account record, raw rows, transactions and sources', async () => {
      await account({
        id: 'R',
        iban: REVOLUT_IBAN,
        bank: 'revolut',
        opening: 1191,
      });

      const outcome = await upload(REVOLUT, { accountId: 'R' });

      expect(outcome).toMatchObject({
        status: 'approved',
        reasons: [],
        redelivered: false,
      });
      const file = (
        await db.query<Record<string, unknown>>('SELECT * FROM statement_files')
      ).rows[0];
      expect(file).toMatchObject({
        status: 'approved',
        bank: 'revolut',
        format_version: 'revolut-v1',
        uploaded_by: 'user-1',
        upload_account_id: 'R',
      });
      expect(file?.['sha256']).toMatch(/^[0-9a-f]{64}$/);
      const perAccount = (
        await db.query<Record<string, unknown>>(
          'SELECT * FROM statement_file_accounts',
        )
      ).rows[0];
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
      await account({
        id: 'R',
        iban: REVOLUT_IBAN,
        bank: 'revolut',
        opening: 1191,
      });

      await upload(REVOLUT_STATES, { accountId: 'R' });

      expect(await count('raw_rows')).toBe(4);
      expect(await count('transactions')).toBe(2);
    });

    it('stores raw values exactly as exported', async () => {
      await account({
        id: 'M',
        iban: MONO_IBAN,
        bank: 'monobank',
        currency: 'UAH',
        opening: 375158 + 0,
      });

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
        await db.query<{ account_id: string }>(
          'SELECT DISTINCT account_id FROM raw_rows ORDER BY 1',
        )
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
      const file = (
        await db.query<Record<string, unknown>>('SELECT * FROM statement_files')
      ).rows[0];
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

    it('acknowledges an unrecorded not-owner rejection when ownership lapses before an early rejection is written', async () => {
      await account({ id: 'R', iban: REVOLUT_IBAN, bank: 'revolut' });
      let revoked = false;

      // Invalid format: rejected by validation, written by recordRejection,
      // after the early ownership check already passed.
      const outcome = await upload('foo,bar\n1,2\n', {
        accountId: 'R',
        hook: async (command) => {
          const sql = command.input['sql'];
          if (
            !revoked &&
            typeof sql === 'string' &&
            sql.includes('INSERT INTO statement_files')
          ) {
            revoked = true;
            await db.exec(
              `INSERT INTO account_members (account_id, user_id, role) VALUES ('R', 'other-owner', 'owner');
               DELETE FROM account_members WHERE account_id = 'R' AND user_id = 'user-1'`,
            );
          }
        },
      });

      expect(revoked).toBe(true);
      expect(outcome.status).toBe('rejected');
      expect(outcome.fileId).toBeNull();
      expect(outcome.reasons[0]?.code).toBe('not-owner');
      expect(await count('statement_files')).toBe(0);
    });

    it('rejects a currency mismatch naming the row', async () => {
      await account({
        id: 'R',
        iban: REVOLUT_IBAN,
        bank: 'revolut',
        currency: 'USD',
        opening: 1191,
      });

      const outcome = await upload(REVOLUT, { accountId: 'R' });

      expect(outcome.status).toBe('rejected');
      expect(outcome.reasons[0]).toMatchObject({
        code: 'currency-mismatch',
        row: 1,
      });
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
      await account({
        id: 'R',
        iban: REVOLUT_IBAN,
        bank: 'revolut',
        viewer: 'viewer-1',
      });

      const outcome = await upload(REVOLUT, {
        accountId: 'R',
        sub: 'viewer-1',
      });

      expect(outcome.reasons[0]?.code).toBe('not-owner');
      // Not recorded: a non-owner can't write statement_files (RLS).
      expect(outcome.fileId).toBeNull();
      expect(await count('statement_files')).toBe(0);
      expect(await count('transactions')).toBe(0);
    });

    it('rejects a re-upload of the same bytes for the same account, naming the earlier import', async () => {
      await account({
        id: 'R',
        iban: REVOLUT_IBAN,
        bank: 'revolut',
        opening: 1191,
      });
      const first = await upload(REVOLUT, { accountId: 'R' });

      const second = await upload(REVOLUT, { accountId: 'R' });

      expect(second.status).toBe('rejected');
      expect(second.reasons[0]?.code).toBe('duplicate-file');
      expect(second.reasons[0]?.message).toContain(first.fileId);
      expect(await count('raw_rows')).toBe(2);
      expect(await count('statement_files')).toBe(2);
    });

    it('does not treat the same bytes for a different account as a duplicate', async () => {
      await account({
        id: 'M1',
        iban: MONO_IBAN,
        bank: 'monobank',
        currency: 'UAH',
        opening: 375158,
      });
      await account({
        id: 'M2',
        iban: 'UA100000000000000078',
        bank: 'monobank',
        currency: 'UAH',
        opening: 375158,
      });
      await upload(MONOBANK, { accountId: 'M1' });

      const second = await upload(MONOBANK, { accountId: 'M2' });

      expect(second.status).toBe('approved');
    });

    it('rejects a raw-only row whose currency differs from the account', async () => {
      await account({
        id: 'R',
        iban: REVOLUT_IBAN,
        bank: 'revolut',
        opening: 1191,
      });
      const csv = [
        REVOLUT_HEADER,
        'Card Payment,Current,2026-08-28 19:20:23,2026-08-29 08:00:00,Lidl,-0.29,0.00,EUR,COMPLETED,11.62',
        'Card Payment,Current,2026-08-29 09:00:00,,Coffee,-3.50,0.00,USD,PENDING,',
      ].join('\n');

      const outcome = await upload(csv, { accountId: 'R' });

      expect(outcome.status).toBe('rejected');
      expect(outcome.reasons).toEqual([
        expect.objectContaining({ code: 'currency-mismatch', row: 2 }),
      ]);
      expect(await count('raw_rows')).toBe(0);
    });

    it('rejects a file with a row too large for one Data API parameter set', async () => {
      await account({
        id: 'R',
        iban: REVOLUT_IBAN,
        bank: 'revolut',
        opening: 1191,
      });
      const csv = [
        REVOLUT_HEADER,
        `Card Payment,Current,2026-08-28 19:20:23,2026-08-29 08:00:00,${'x'.repeat(1_100_000)},-0.29,0.00,EUR,COMPLETED,11.62`,
      ].join('\n');

      const outcome = await upload(csv, { accountId: 'R' });

      expect(outcome.status).toBe('rejected');
      expect(outcome.reasons).toEqual([
        expect.objectContaining({ code: 'row-too-large', row: 1 }),
      ]);
      expect(await count('raw_rows')).toBe(0);
    });

    it('rejects when ownership is revoked after the early check but before the write transaction commits', async () => {
      await account({
        id: 'R',
        iban: REVOLUT_IBAN,
        bank: 'revolut',
        opening: 1191,
      });
      let revoked = false;

      const outcome = await upload(REVOLUT, {
        accountId: 'R',
        hook: async (command) => {
          const sql = command.input['sql'];
          if (
            !revoked &&
            typeof sql === 'string' &&
            sql.includes('lock_timeout')
          ) {
            revoked = true;
            // Same pglite connection, so this lands inside the import's transaction window.
            // An account always keeps an owner, so another owner removes the uploader.
            await db.exec(
              `INSERT INTO account_members (account_id, user_id, role) VALUES ('R', 'other-owner', 'owner');
               DELETE FROM account_members WHERE account_id = 'R' AND user_id = 'user-1'`,
            );
          }
        },
      });

      expect(outcome.status).toBe('rejected');
      expect(outcome.reasons[0]?.code).toBe('not-owner');
      expect(outcome.fileId).toBeNull();
      expect(await count('statement_files')).toBe(0);
      expect(await count('raw_rows')).toBe(0);
      expect(await count('transactions')).toBe(0);
    });

    it('holds a share lock on the owner rows inside the write transaction', async () => {
      await account({
        id: 'R',
        iban: REVOLUT_IBAN,
        bank: 'revolut',
        opening: 1191,
      });

      await upload(REVOLUT, { accountId: 'R' });

      const joined = sqlLog.join('\n');
      expect(joined).toMatch(/FROM account_members[\s\S]*FOR SHARE/);
      expect(joined.indexOf('FOR SHARE')).toBeLessThan(
        joined.indexOf('INSERT INTO statement_files'),
      );
    });

    it('maps the partial-unique-index race to a duplicate rejection', async () => {
      await account({
        id: 'R',
        iban: REVOLUT_IBAN,
        bank: 'revolut',
        opening: 1191,
      });
      await upload(REVOLUT, { accountId: 'R' });

      // Hide the duplicate pre-check so the insert itself hits the index.
      const outcome = await upload(REVOLUT, {
        accountId: 'R',
        hook: (command) => {
          const sql = command.input['sql'];
          if (typeof sql === 'string' && sql.includes("status = 'approved'")) {
            command.input['sql'] = sql.replace(
              "status = 'approved'",
              "status = 'nonexistent'",
            );
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
      revolutRow(
        '2026-01-02 10:00:00',
        '2026-01-02 10:00:00',
        'Alpha',
        '-1.00',
        '9.00',
      ),
      revolutRow(
        '2026-01-03 10:00:00',
        '2026-01-03 10:00:00',
        'Bravo',
        '-1.00',
        '8.00',
      ),
    ].join('\n');
    const file2 = [
      REVOLUT_HEADER,
      revolutRow(
        '2026-01-03 10:00:00',
        '2026-01-03 10:00:00',
        'Bravo',
        '-1.00',
        '8.00',
      ),
      revolutRow(
        '2026-01-04 10:00:00',
        '2026-01-04 10:00:00',
        'Charlie',
        '-1.00',
        '7.00',
      ),
    ].join('\n');

    it('adds a source to an overlapping transaction instead of duplicating it', async () => {
      await account({
        id: 'R',
        iban: REVOLUT_IBAN,
        bank: 'revolut',
        opening: 1000,
      });
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
      await account({
        id: 'R',
        iban: REVOLUT_IBAN,
        bank: 'revolut',
        opening: 1000,
      });
      await upload(file1, { accountId: 'R' });
      const conflicting = [
        REVOLUT_HEADER,
        revolutRow(
          '2026-01-03 10:00:00',
          '2026-01-03 10:00:00',
          'Bravo',
          '-1.00',
          '7.50',
        ),
      ].join('\n');

      const outcome = await upload(conflicting, { accountId: 'R' });

      expect(outcome.status).toBe('rejected');
      expect(outcome.reasons[0]).toMatchObject({
        code: 'conflicting-overlap',
        row: 1,
      });
      expect(await count('transactions')).toBe(2);
    });

    it('approves exactly one of two SEB files carrying the same provider id with different amounts', async () => {
      await account({ id: 'A', iban: IBAN_A });
      await account({ id: 'B', iban: IBAN_B });
      const altered = SEB.replace(
        '"EUR";50,00;"VARDENIS',
        '"EUR";51,00;"VARDENIS',
      );
      expect(altered).not.toBe(SEB);

      const first = await upload(SEB, { accountId: 'A' });
      const second = await upload(altered, { accountId: 'A' });

      expect([first.status, second.status].sort()).toEqual([
        'approved',
        'rejected',
      ]);
      expect(second.reasons[0]?.code).toBe('conflicting-overlap');
    });
  });

  describe('continuity rejections', () => {
    const revolutFile = (...rows: string[]) =>
      [REVOLUT_HEADER, ...rows].join('\n');
    const day = (
      date: string,
      description: string,
      balance: string,
      time = '10:00:00',
    ) =>
      revolutRow(
        `${date} ${time}`,
        `${date} ${time}`,
        description,
        '-1.00',
        balance,
      );
    const revolutAccount = () =>
      account({ id: 'R', iban: REVOLUT_IBAN, bank: 'revolut', opening: 1000 });
    const storedCount = async () =>
      Number(
        (
          await db.query<{ n: string }>(
            'SELECT count(*) AS n FROM transactions',
          )
        ).rows[0]?.n,
      );

    it('rejects an out-of-order file, naming the missing period, and stores nothing', async () => {
      await revolutAccount();
      await upload(revolutFile(day('2026-03-02', 'March', '9.00')), {
        accountId: 'R',
      });
      const before = await storedCount();
      // March opens at 10.00 (the account's opening); January closes at 9.00

      const outcome = await upload(
        revolutFile(day('2026-01-02', 'January', '9.00')),
        { accountId: 'R' },
      );

      expect(outcome.status).toBe('rejected');
      expect(outcome.reasons.map((r) => r.code)).toContain('gap-after');
      expect(outcome.reasons[0]?.message).toMatch(
        /ends 2026-01-02 and stored history starts 2026-03-02.*2026-01-03 to 2026-03-01/,
      );
      expect(await storedCount()).toBe(before);
      const files = await db.query<{ status: string }>(
        `SELECT status FROM statement_files WHERE id = $1`,
        [outcome.fileId],
      );
      expect(files.rows).toEqual([{ status: 'rejected' }]);
    });

    it('approves a file that connects to history and the opening', async () => {
      await revolutAccount();
      const first = await upload(
        revolutFile(day('2026-01-02', 'Jan', '9.00')),
        { accountId: 'R' },
      );

      const second = await upload(
        revolutFile(day('2026-02-02', 'Feb', '8.00')),
        { accountId: 'R' },
      );

      expect(first.status).toBe('approved');
      expect(second.status).toBe('approved');
      expect(second.warningsByAccount['R']).toEqual([]);
    });

    it('rejects a first file that does not match the account opening, naming it', async () => {
      await account({
        id: 'R',
        iban: REVOLUT_IBAN,
        bank: 'revolut',
        opening: 5,
      });

      const outcome = await upload(REVOLUT, { accountId: 'R' });

      expect(outcome.status).toBe('rejected');
      expect(outcome.reasons.map((r) => r.code)).toEqual(['gap-opening']);
      expect(outcome.reasons[0]?.message).toMatch(/0\.05 EUR on 2026-01-01/);
      expect(await storedCount()).toBe(0);
    });

    it('rejects February processed before January, then approves it uploaded again after January', async () => {
      await revolutAccount();
      const jan = revolutFile(day('2026-01-02', 'Jan', '9.00'));
      const feb = revolutFile(day('2026-02-02', 'Feb', '8.00'));

      const early = await upload(feb, { accountId: 'R' });
      const januaryOutcome = await upload(jan, { accountId: 'R' });
      const retry = await upload(feb, { accountId: 'R' });

      expect(early.status).toBe('rejected');
      expect(januaryOutcome.status).toBe('approved');
      expect(retry.status).toBe('approved');
      const { rows } = await db.query<Record<string, string | boolean>>(
        `SELECT balance_minor_units::text AS balance, balance_reconciled FROM accounts WHERE id = 'R'`,
      );
      expect(rows).toEqual([{ balance: '800', balance_reconciled: true }]);
    });
  });

  describe('stored balances', () => {
    const revolutFile = (...rows: string[]) =>
      [REVOLUT_HEADER, ...rows].join('\n');
    const revolutAccount = (opening = 1000) =>
      account({ id: 'R', iban: REVOLUT_IBAN, bank: 'revolut', opening });
    const accountRow = async (id = 'R') =>
      (
        await db.query<Record<string, unknown>>(
          `SELECT balance_minor_units::text AS balance, balance_as_of::text AS as_of, balance_reconciled AS reconciled
             FROM accounts WHERE id = $1`,
          [id],
        )
      ).rows[0];

    it('sets the account balance, as-of date and per-row running balances', async () => {
      await revolutAccount();

      const outcome = await upload(
        revolutFile(
          // started on the 2nd, completed on the 3rd
          revolutRow(
            '2026-01-02 23:50:00',
            '2026-01-03 00:10:00',
            'Late',
            '-1.00',
            '9.00',
          ),
          revolutRow(
            '2026-01-03 09:00:00',
            '2026-01-03 09:00:00',
            'Next',
            '-1.00',
            '8.00',
          ),
        ),
        { accountId: 'R' },
      );

      expect(outcome.status).toBe('approved');
      expect(await accountRow()).toEqual({
        balance: '800',
        as_of: '2026-01-03',
        reconciled: true,
      });
      const { rows } = await db.query<{ d: string; b: string }>(
        `SELECT description AS d, running_balance_minor_units::text AS b
           FROM transactions ORDER BY occurred_at, source_seq, id`,
      );
      expect(rows).toEqual([
        { d: 'late', b: '900' },
        { d: 'next', b: '800' },
      ]);
    });

    it('takes the fee off the balance and keeps the bank balance separately', async () => {
      await revolutAccount();

      await upload(
        revolutFile(
          revolutRow(
            '2026-01-02 10:00:00',
            '2026-01-02 10:00:00',
            'Fee',
            '-1.00',
            '8.50',
            '0.50',
          ),
        ),
        { accountId: 'R' },
      );

      expect((await accountRow())?.['balance']).toBe('850');
      const { rows } = await db.query<Record<string, string>>(
        `SELECT balance_after_minor_units::text AS bank, running_balance_minor_units::text AS running FROM transactions`,
      );
      expect(rows).toEqual([{ bank: '850', running: '850' }]);
    });

    it('rejects a file whose closing balance disagrees, naming both amounts, storing nothing', async () => {
      await revolutAccount();
      await upload(
        revolutFile(
          revolutRow(
            '2026-01-02 10:00:00',
            '2026-01-02 10:00:00',
            'Alpha',
            '-1.00',
            '9.00',
          ),
          revolutRow(
            '2026-01-04 10:00:00',
            '2026-01-04 10:00:00',
            'Bravo',
            '-1.00',
            '8.00',
          ),
        ),
        { accountId: 'R' },
      );
      const before = await accountRow();
      // Overlaps by date (so it is "continuous") but its opening 9.00 ignores
      // Bravo: computed 7.00 after it, the bank says 8.00.
      const outcome = await upload(
        revolutFile(
          revolutRow(
            '2026-01-04 11:00:00',
            '2026-01-04 11:00:00',
            'Extra',
            '-1.00',
            '8.00',
          ),
        ),
        { accountId: 'R' },
      );

      expect(outcome.status).toBe('rejected');
      expect(outcome.reasons.map((r) => r.code)).toEqual([
        'closing-balance-mismatch',
      ]);
      expect(outcome.reasons[0]?.message).toMatch(/8\.00 EUR.*7\.00 EUR/);
      expect(await accountRow()).toEqual(before);
      expect(
        Number(
          (
            await db.query<{ n: string }>(
              'SELECT count(*) AS n FROM transactions',
            )
          ).rows[0]?.n,
        ),
      ).toBe(2);
      const files = await db.query<{ status: string }>(
        `SELECT status FROM statement_files ORDER BY import_seq`,
      );
      expect(files.rows.map((f) => f.status)).toEqual(['approved', 'rejected']);
    });

    it('approves an SEB file without comparing to a bank balance', async () => {
      await account({ id: 'A', iban: IBAN_A, opening: 100000 });
      await account({ id: 'B', iban: IBAN_B, opening: 500000 });

      const outcome = await upload(SEB, { accountId: 'A' });

      expect(outcome.status).toBe('approved');
      const { rows } = await db.query<{ id: string; sum: string }>(
        `SELECT account_id AS id, SUM(amount_minor_units - fee_minor_units)::text AS sum
           FROM transactions GROUP BY account_id ORDER BY account_id`,
      );
      for (const { id, sum } of rows) {
        const opening = id === 'A' ? 100000 : 500000;
        expect((await accountRow(id))?.['balance']).toBe(
          String(opening + Number(sum)),
        );
      }
    });

    it('leaves the old balances when a write fails after the recompute', async () => {
      await revolutAccount();
      const before = await accountRow();

      await expect(
        upload(
          revolutFile(
            revolutRow(
              '2026-01-02 10:00:00',
              '2026-01-02 10:00:00',
              'Alpha',
              '-1.00',
              '9.00',
            ),
          ),
          {
            accountId: 'R',
            hook: (command) => {
              const sql = command.input['sql'];
              // The outbox row is written after the balances are recomputed.
              if (
                typeof sql === 'string' &&
                sql.includes('draupnir.enqueue_outcome')
              ) {
                throw new Error('simulated write failure');
              }
            },
          },
        ),
      ).rejects.toThrow('simulated write failure');

      expect(await accountRow()).toEqual(before);
      const { rows } = await db.query<{ n: string }>(
        'SELECT count(*) AS n FROM transactions',
      );
      expect(Number(rows[0]?.n)).toBe(0);
    });

    it('keeps the balance equal to opening plus every stored transaction across successive imports', async () => {
      await revolutAccount();
      await upload(
        revolutFile(
          revolutRow(
            '2026-01-02 10:00:00',
            '2026-01-02 10:00:00',
            'A',
            '-1.00',
            '9.00',
          ),
        ),
        { accountId: 'R' },
      );
      await upload(
        revolutFile(
          revolutRow(
            '2026-01-03 10:00:00',
            '2026-01-03 10:00:00',
            'B',
            '-1.00',
            '8.00',
          ),
        ),
        { accountId: 'R' },
      );

      const { rows } = await db.query<{ expected: string }>(
        `SELECT (a.opening_balance_minor_units + SUM(t.amount_minor_units - t.fee_minor_units))::text AS expected
           FROM accounts a JOIN transactions t ON t.account_id = a.id GROUP BY a.id, a.opening_balance_minor_units`,
      );
      expect((await accountRow())?.['balance']).toBe(rows[0]?.expected);
    });

    it('leaves the balance unchanged for a duplicate file', async () => {
      await revolutAccount();
      const file = revolutFile(
        revolutRow(
          '2026-01-02 10:00:00',
          '2026-01-02 10:00:00',
          'Alpha',
          '-1.00',
          '9.00',
        ),
      );
      await upload(file, { accountId: 'R' });
      const before = await accountRow();

      const again = await upload(file, { accountId: 'R' });

      expect(again.status).toBe('rejected');
      expect(await accountRow()).toEqual(before);
    });
  });

  describe('outcome outbox', () => {
    const outbox = async () =>
      (
        await db.query<{
          file_id: string;
          s3_key: string;
          uploaded_by: string;
          published_at: string | null;
          payload: Record<string, unknown>;
        }>('SELECT * FROM statement_outcome_outbox ORDER BY created_at')
      ).rows;

    it('commits an approved outcome with its outbox row, and returns the message to publish', async () => {
      await account({
        id: 'R',
        iban: REVOLUT_IBAN,
        bank: 'revolut',
        opening: 1191,
      });

      const outcome = await upload(REVOLUT, { accountId: 'R' });

      const rows = await outbox();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        file_id: outcome.fileId,
        uploaded_by: 'user-1',
        published_at: null,
      });
      expect(outcome.report).toMatchObject({
        fileId: outcome.fileId,
        sub: 'user-1',
        status: 'approved',
        reasons: [],
        newTransactionCount: 2,
      });
      expect(outcome.report?.period?.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(outcome.report?.s3Key).toBe(rows[0]?.s3_key);
      expect(rows[0]?.payload).toEqual(outcome.report);
    });

    it('commits a rejected outcome with its outbox row and every reason', async () => {
      await account({ id: 'R', iban: REVOLUT_IBAN, bank: 'revolut' });
      const bad = `${REVOLUT_HEADER}\nCard Payment,Current,x,y,Lidl,abc,0.00,EUR,COMPLETED,1.00\n`;

      const outcome = await upload(bad, { accountId: 'R' });

      const rows = await outbox();
      expect(rows).toHaveLength(1);
      expect(outcome.report).toMatchObject({
        fileId: outcome.fileId,
        status: 'rejected',
        newTransactionCount: 0,
        period: null,
      });
      expect(outcome.report?.reasons).toEqual(outcome.reasons);
      expect(rows[0]?.payload).toEqual(outcome.report);
    });

    it('writes no outbox row when the outcome’s transaction fails and rolls back', async () => {
      await account({
        id: 'R',
        iban: REVOLUT_IBAN,
        bank: 'revolut',
        opening: 1191,
      });

      await expect(
        upload(REVOLUT, {
          accountId: 'R',
          hook: (command) => {
            const sql = command.input['sql'];
            if (
              typeof sql === 'string' &&
              sql.includes('draupnir.enqueue_outcome')
            ) {
              throw new Error('outbox write failed');
            }
          },
        }),
      ).rejects.toThrow('outbox write failed');

      // The outcome and its outbox row commit together or not at all.
      expect(await count('statement_files')).toBe(0);
      expect(await outbox()).toEqual([]);
    });

    it('keeps a committed approval an approval when the uploader has since left the account', async () => {
      await account({
        id: 'R',
        iban: REVOLUT_IBAN,
        bank: 'revolut',
        opening: 1191,
      });
      const key = 'uploads/user-1/R/removed-after.csv';
      const first = await upload(REVOLUT, { accountId: 'R', key });
      // another owner remains; the uploader is removed before the redelivery
      await db.exec(`
        INSERT INTO account_members (account_id, user_id, role) VALUES ('R', 'other-owner', 'owner');
        DELETE FROM account_members WHERE account_id = 'R' AND user_id = 'user-1'
      `);

      const again = await upload(REVOLUT, { accountId: 'R', key });

      expect(again).toMatchObject({
        fileId: first.fileId,
        status: 'approved',
        redelivered: true,
        report: null,
      });
      expect(again.reasons).toEqual([]);
      expect(await outbox()).toHaveLength(1); // nothing new to publish
    });

    it('bounds the published message for a file with thousands of bad rows, keeping the full list on the file', async () => {
      await account({ id: 'R', iban: REVOLUT_IBAN, bank: 'revolut' });
      const rows = Array.from(
        { length: 200 },
        (_, i) =>
          `Card Payment,Current,x,y,Lidl ${i},abc,0.00,EUR,COMPLETED,1.00`,
      );

      const outcome = await upload(`${REVOLUT_HEADER}\n${rows.join('\n')}\n`, {
        accountId: 'R',
      });

      expect(outcome.reasons.length).toBeGreaterThan(30);
      expect(outcome.report?.reasons).toHaveLength(30);
      expect(outcome.report?.omittedReasonCount).toBe(
        outcome.reasons.length - 30,
      );
      const stored = (
        await db.query<{ rejection_reasons: unknown[] }>(
          'SELECT rejection_reasons FROM statement_files',
        )
      ).rows[0]?.rejection_reasons;
      expect(stored).toHaveLength(outcome.reasons.length);
    });

    it('does not enqueue a second message when the object is redelivered', async () => {
      await account({
        id: 'R',
        iban: REVOLUT_IBAN,
        bank: 'revolut',
        opening: 1191,
      });
      const key = 'uploads/user-1/R/same-object.csv';
      await upload(REVOLUT, { accountId: 'R', key });

      const again = await upload(REVOLUT, { accountId: 'R', key });

      expect(again.redelivered).toBe(true);
      expect(again.report).toBeNull();
      expect(await outbox()).toHaveLength(1);
    });

    it('gives an unrecorded not-owner rejection a message but no outbox row', async () => {
      await account({ id: 'R', iban: REVOLUT_IBAN, bank: 'revolut' });

      const outcome = await upload(REVOLUT, {
        accountId: 'R',
        sub: 'removed-user',
        key: 'uploads/removed-user/R/x.csv',
      });

      expect(outcome.fileId).toBeNull();
      expect(outcome.report).toMatchObject({
        fileId: null,
        s3Key: 'uploads/removed-user/R/x.csv',
        sub: 'removed-user',
        status: 'rejected',
      });
      expect(outcome.report?.reasons[0]?.code).toBe('not-owner');
      expect(await outbox()).toEqual([]);
    });
  });

  describe('redelivery and failure', () => {
    it('returns the recorded outcome for a redelivered object without creating a second record', async () => {
      await account({
        id: 'R',
        iban: REVOLUT_IBAN,
        bank: 'revolut',
        opening: 1191,
      });
      const key = 'uploads/user-1/R/same-object.csv';
      const first = await upload(REVOLUT, { accountId: 'R', key });

      const again = await upload(REVOLUT, { accountId: 'R', key });

      expect(again).toMatchObject({
        fileId: first.fileId,
        status: 'approved',
        redelivered: true,
      });
      expect(await count('statement_files')).toBe(1);
      expect(await count('raw_rows')).toBe(2);
    });

    it('returns the recorded rejection for a redelivered rejected object', async () => {
      await account({ id: 'R', iban: REVOLUT_IBAN, bank: 'revolut' });
      const key = 'uploads/user-1/R/bad.csv';
      const first = await upload('foo,bar\n', { accountId: 'R', key });

      const again = await upload('foo,bar\n', { accountId: 'R', key });

      expect(again).toMatchObject({
        fileId: first.fileId,
        status: 'rejected',
        redelivered: true,
      });
      expect(again.reasons).toEqual(first.reasons);
      expect(await count('statement_files')).toBe(1);
    });

    it('leaves no partial rows when a write fails partway, and surfaces the error', async () => {
      await account({
        id: 'R',
        iban: REVOLUT_IBAN,
        bank: 'revolut',
        opening: 1191,
      });

      await expect(
        upload(REVOLUT, {
          accountId: 'R',
          hook: (command) => {
            const sql = command.input['sql'];
            if (
              typeof sql === 'string' &&
              sql.includes('INSERT INTO transactions')
            ) {
              throw new Error('boom');
            }
          },
        }),
      ).rejects.toThrow('boom');

      expect(await count('statement_files')).toBe(0);
      expect(await count('raw_rows')).toBe(0);
      expect(await count('transactions')).toBe(0);
    });

    it('acknowledges an unrecorded not-owner rejection when the account is not visible to the uploader', async () => {
      // A nonexistent account and one the uploader was removed from are
      // indistinguishable under RLS; neither may retry into the DLQ.
      await account({ id: 'R', iban: REVOLUT_IBAN, bank: 'revolut' });
      for (const accountId of ['ghost', 'R']) {
        const outcome = await upload(REVOLUT, {
          accountId,
          sub: 'removed-user',
        });

        expect(outcome.status).toBe('rejected');
        expect(outcome.fileId).toBeNull();
        expect(outcome.reasons[0]?.code).toBe('not-owner');
      }
      expect(await count('statement_files')).toBe(0);
    });

    it('rejects an oversized file from the event size before touching S3', async () => {
      await expect(
        upload('x', { accountId: 'R', size: 11 * 1024 * 1024 }),
      ).rejects.toBeInstanceOf(OversizedStatementFileError);
    });
  });
});
