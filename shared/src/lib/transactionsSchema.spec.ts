// @vitest-environment node
// pglite's WASM/fs loading relies on the real Node fetch/Response, which
// jsdom (this project's default test environment) does not implement.
import { parse } from 'pgsql-ast-parser';
import { PGlite } from '@electric-sql/pglite';
import { m0002 } from './migrations/0002-statement-data-model';
import { applyMigrationsForTest } from './migrations/applyMigrationsForTest';

function createTableStatement(name: string) {
  const statement = m0002.statements
    .flatMap((sql) => parse(sql))
    .find(
      (parsed) => parsed.type === 'create table' && parsed.name.name === name,
    );
  if (statement?.type !== 'create table') {
    throw new Error(`expected a create table statement for ${name}`);
  }
  return statement;
}

function columnNames(table: string): string[] {
  return createTableStatement(table).columns.map((c) => c.name.name);
}

describe('migration 0002 DDL', () => {
  it('accounts has no owner column and records the opening balance', () => {
    expect(columnNames('accounts')).toEqual([
      'id',
      'bank',
      'iban',
      'currency',
      'display_name',
      'opened_on',
      'opening_balance_minor_units',
      'created_at',
    ]);
  });

  it('transactions has no owner column and carries fee and balance-after', () => {
    expect(columnNames('transactions')).toEqual([
      'id',
      'account_id',
      'posted_date',
      'amount_minor_units',
      'currency',
      'description',
      'fee_minor_units',
      'balance_after_minor_units',
      'dedup_key',
      'original_currency',
      'original_amount_minor_units',
      'fx_fee_minor_units',
      'fx_fee_percent',
      'created_at',
    ]);
  });

  it('creates the membership and statement tables', () => {
    expect(columnNames('account_members')).toEqual([
      'account_id',
      'user_id',
      'role',
      'created_at',
    ]);
    expect(columnNames('statement_files')).toContain('s3_key');
    expect(columnNames('statement_file_accounts')).toContain('warnings');
    expect(columnNames('raw_rows')).toContain('payload');
    expect(columnNames('transaction_sources')).toEqual([
      'transaction_id',
      'raw_row_id',
      'account_id',
    ]);
  });
});

describe('migrated schema on a real Postgres instance', () => {
  let db: PGlite;

  // One database per file (booting pglite per test is slow); tables are
  // emptied between tests instead.
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
  });

  let ibanCounter = 0;

  async function insertAccount(overrides?: {
    iban?: string;
    bank?: string;
    openedOn?: string;
    openingBalance?: number;
  }): Promise<string> {
    ibanCounter += 1;
    const result = await db.query<{ id: string }>(
      `INSERT INTO accounts (bank, iban, currency, display_name, opened_on, opening_balance_minor_units)
       VALUES ($1, $2, 'EUR', 'SEB checking', $3, $4) RETURNING id`,
      [
        overrides?.bank ?? 'seb',
        overrides?.iban ??
          `LT10000000000000${String(ibanCounter).padStart(4, '0')}`,
        overrides?.openedOn ?? '2024-01-15',
        overrides?.openingBalance ?? 0,
      ],
    );
    return (result.rows[0] as { id: string }).id;
  }

  async function insertFile(
    accountId: string,
    overrides?: { sha256?: string; s3Key?: string; status?: string },
  ): Promise<string> {
    ibanCounter += 1;
    const result = await db.query<{ id: string }>(
      `INSERT INTO statement_files (upload_account_id, uploaded_by, bank, format_version, sha256, s3_key, status)
       VALUES ($1, 'user-1', 'seb', 'v1', $2, $3, $4) RETURNING id`,
      [
        accountId,
        overrides?.sha256 ?? 'abc',
        overrides?.s3Key ?? `uploads/user-1/${accountId}/${ibanCounter}.csv`,
        overrides?.status ?? 'approved',
      ],
    );
    return (result.rows[0] as { id: string }).id;
  }

  async function insertRawRow(
    fileId: string,
    accountId: string,
    rowNumber = 1,
  ): Promise<string> {
    // A raw row must belong to an account the file resolved to.
    await db.query(
      `INSERT INTO statement_file_accounts (file_id, account_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [fileId, accountId],
    );
    const result = await db.query<{ id: string }>(
      `INSERT INTO raw_rows (file_id, account_id, row_number, bank, format_version, payload)
       VALUES ($1, $2, $3, 'seb', 'v1', '{"Suma":"50,00"}'::jsonb) RETURNING id`,
      [fileId, accountId, rowNumber],
    );
    return (result.rows[0] as { id: string }).id;
  }

  async function insertTransaction(
    accountId: string,
    dedupKey: string,
    fx?: {
      originalCurrency?: string | null;
      originalAmountMinorUnits?: number | null;
      fxFeeMinorUnits?: number | null;
      fxFeePercent?: number | null;
    },
  ): Promise<string | undefined> {
    const result = await db.query<{ id: string }>(
      `INSERT INTO transactions
         (account_id, posted_date, amount_minor_units, currency, description, dedup_key,
          original_currency, original_amount_minor_units, fx_fee_minor_units, fx_fee_percent)
       VALUES ($1, '2026-08-29', -1050, 'EUR', 'lidl', $2, $3, $4, $5, $6)
       ON CONFLICT (account_id, dedup_key) DO NOTHING RETURNING id`,
      [
        accountId,
        dedupKey,
        fx?.originalCurrency ?? null,
        fx?.originalAmountMinorUnits ?? null,
        fx?.fxFeeMinorUnits ?? null,
        fx?.fxFeePercent ?? null,
      ],
    );
    return result.rows[0]?.id;
  }

  describe('accounts', () => {
    it('inserts a valid row', async () => {
      expect(await insertAccount()).toBeTruthy();
    });

    it('records the opening date and balance', async () => {
      const id = await insertAccount({
        openedOn: '2024-01-15',
        openingBalance: 0,
      });

      const { rows } = await db.query<{
        opened_on: Date;
        opening_balance_minor_units: string | number;
      }>(
        'SELECT opened_on, opening_balance_minor_units FROM accounts WHERE id = $1',
        [id],
      );
      expect(rows[0]?.opened_on.toISOString().slice(0, 10)).toBe('2024-01-15');
      expect(Number(rows[0]?.opening_balance_minor_units)).toBe(0);
    });

    it('rejects a duplicate iban', async () => {
      await insertAccount({ iban: 'LT100000000000000001' });

      await expect(
        insertAccount({ iban: 'LT100000000000000001' }),
      ).rejects.toThrow();
    });

    it('rejects an unknown bank value', async () => {
      await expect(insertAccount({ bank: 'chase' })).rejects.toThrow();
    });

    it('accepts a supported bank value', async () => {
      const id = await insertAccount({ bank: 'seb' });
      const { rows } = await db.query<{ bank: string }>(
        'SELECT bank FROM accounts WHERE id = $1',
        [id],
      );
      expect(rows[0]?.bank).toBe('seb');
    });
  });

  describe('account_members', () => {
    it('rejects a role other than owner or viewer', async () => {
      const accountId = await insertAccount();

      await expect(
        db.query(
          `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, 'u', 'admin')`,
          [accountId],
        ),
      ).rejects.toThrow();
    });

    it('accepts owner and viewer', async () => {
      const accountId = await insertAccount();

      await db.query(
        `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, 'u1', 'owner'), ($1, 'u2', 'viewer')`,
        [accountId],
      );

      const { rows } = await db.query('SELECT * FROM account_members');
      expect(rows).toHaveLength(2);
    });

    it('rejects a second membership row for the same user and account', async () => {
      const accountId = await insertAccount();
      await db.query(
        `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, 'u1', 'owner')`,
        [accountId],
      );

      await expect(
        db.query(
          `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, 'u1', 'viewer')`,
          [accountId],
        ),
      ).rejects.toThrow();
    });
  });

  describe('transactions', () => {
    it('a duplicate dedup_key on the same account is absorbed', async () => {
      const accountId = await insertAccount();

      await insertTransaction(accountId, 'seb:RO1000000001L01');
      await insertTransaction(accountId, 'seb:RO1000000001L01');

      const { rows } = await db.query('SELECT * FROM transactions');
      expect(rows).toHaveLength(1);
    });

    it('the same dedup_key on different accounts both persist', async () => {
      const a = await insertAccount();
      const b = await insertAccount();

      await insertTransaction(a, 'seb:RO1000000001L01');
      await insertTransaction(b, 'seb:RO1000000001L01');

      const { rows } = await db.query('SELECT * FROM transactions');
      expect(rows).toHaveLength(2);
    });

    it('distinct dedup_keys both persist', async () => {
      const accountId = await insertAccount();

      await insertTransaction(accountId, 'seb:RO1000000001L01');
      await insertTransaction(accountId, 'seb:RO1000000002L01');

      const { rows } = await db.query('SELECT * FROM transactions');
      expect(rows).toHaveLength(2);
    });

    it('fee defaults to 0 and balance-after to null', async () => {
      const accountId = await insertAccount();
      await insertTransaction(accountId, 'k1');

      const { rows } = await db.query<{
        fee_minor_units: string | number;
        balance_after_minor_units: string | number | null;
      }>('SELECT fee_minor_units, balance_after_minor_units FROM transactions');
      expect(Number(rows[0]?.fee_minor_units)).toBe(0);
      expect(rows[0]?.balance_after_minor_units).toBeNull();
    });

    it('FX metadata columns default to null', async () => {
      const accountId = await insertAccount();
      await insertTransaction(accountId, 'k1');

      const { rows } = await db.query('SELECT * FROM transactions');
      expect(rows[0]).toMatchObject({
        original_currency: null,
        original_amount_minor_units: null,
        fx_fee_minor_units: null,
        fx_fee_percent: null,
      });
    });

    it('rejects original_currency set without original_amount_minor_units', async () => {
      const accountId = await insertAccount();
      await expect(
        insertTransaction(accountId, 'k1', { originalCurrency: 'NOK' }),
      ).rejects.toThrow();
    });

    it('rejects original_amount_minor_units set without original_currency', async () => {
      const accountId = await insertAccount();
      await expect(
        insertTransaction(accountId, 'k1', { originalAmountMinorUnits: 29900 }),
      ).rejects.toThrow();
    });

    it('rejects fx_fee_minor_units set without fx_fee_percent', async () => {
      const accountId = await insertAccount();
      await expect(
        insertTransaction(accountId, 'k1', { fxFeeMinorUnits: 68 }),
      ).rejects.toThrow();
    });

    it('rejects fx_fee_percent set without fx_fee_minor_units', async () => {
      const accountId = await insertAccount();
      await expect(
        insertTransaction(accountId, 'k1', { fxFeePercent: 2.65 }),
      ).rejects.toThrow();
    });

    it('accepts all four FX metadata columns set together', async () => {
      const accountId = await insertAccount();
      await insertTransaction(accountId, 'k1', {
        originalCurrency: 'NOK',
        originalAmountMinorUnits: 29900,
        fxFeeMinorUnits: 68,
        fxFeePercent: 2.65,
      });

      const { rows } = await db.query('SELECT * FROM transactions');
      expect(rows).toHaveLength(1);
    });
  });

  describe('statement_files', () => {
    it('rejects a second approved row with the same (upload_account_id, sha256)', async () => {
      const accountId = await insertAccount();
      await insertFile(accountId, { sha256: 'same' });

      await expect(insertFile(accountId, { sha256: 'same' })).rejects.toThrow();
    });

    it('allows a rejected row alongside an approved one with the same sha256', async () => {
      const accountId = await insertAccount();
      await insertFile(accountId, { sha256: 'same' });

      await insertFile(accountId, { sha256: 'same', status: 'rejected' });

      const { rows } = await db.query('SELECT * FROM statement_files');
      expect(rows).toHaveLength(2);
    });

    it('allows the same sha256 on a different upload account', async () => {
      const a = await insertAccount();
      const b = await insertAccount();
      await insertFile(a, { sha256: 'same' });

      await insertFile(b, { sha256: 'same' });

      const { rows } = await db.query('SELECT * FROM statement_files');
      expect(rows).toHaveLength(2);
    });

    it('rejects a duplicate s3_key', async () => {
      const accountId = await insertAccount();
      await insertFile(accountId, { sha256: 'a', s3Key: 'uploads/x.csv' });

      await expect(
        insertFile(accountId, { sha256: 'b', s3Key: 'uploads/x.csv' }),
      ).rejects.toThrow();
    });

    it('rejects a status other than approved or rejected', async () => {
      const accountId = await insertAccount();
      await expect(
        insertFile(accountId, { status: 'pending' }),
      ).rejects.toThrow();
    });
  });

  describe('statement_files import order', () => {
    it('assigns an increasing import_seq in insert order, independent of processed_at', async () => {
      const accountId = await insertAccount();
      const first = await insertFile(accountId, { sha256: 'a' });
      const second = await insertFile(accountId, { sha256: 'b' });
      // Make wall-clock order contradict insert order.
      await db.query(
        `UPDATE statement_files SET processed_at = now() + interval '1 hour' WHERE id = $1`,
        [first],
      );

      const { rows } = await db.query<{ id: string }>(
        'SELECT id FROM statement_files ORDER BY import_seq',
      );
      expect(rows.map((r) => r.id)).toEqual([first, second]);
    });
  });

  describe('raw_rows', () => {
    it('rejects a duplicate (file_id, row_number)', async () => {
      const accountId = await insertAccount();
      const fileId = await insertFile(accountId);
      await insertRawRow(fileId, accountId, 1);

      await expect(insertRawRow(fileId, accountId, 1)).rejects.toThrow();
    });

    it('rejects a raw row for an account the file did not resolve to', async () => {
      const a = await insertAccount();
      const b = await insertAccount();
      const fileId = await insertFile(a);
      await db.query(
        'INSERT INTO statement_file_accounts (file_id, account_id) VALUES ($1, $2)',
        [fileId, a],
      );

      await expect(
        db.query(
          `INSERT INTO raw_rows (file_id, account_id, row_number, bank, format_version, payload)
           VALUES ($1, $2, 1, 'seb', 'v1', '{}'::jsonb)`,
          [fileId, b],
        ),
      ).rejects.toThrow();
    });

    it('stores the payload exactly as strings', async () => {
      const accountId = await insertAccount();
      const fileId = await insertFile(accountId);
      await insertRawRow(fileId, accountId, 1);

      const { rows } = await db.query<{ payload: Record<string, string> }>(
        'SELECT payload FROM raw_rows',
      );
      expect(rows[0]?.payload).toEqual({ Suma: '50,00' });
    });
  });

  describe('transaction_sources', () => {
    it('links a transaction and a raw row of the same account', async () => {
      const accountId = await insertAccount();
      const fileId = await insertFile(accountId);
      const rawRowId = await insertRawRow(fileId, accountId);
      const transactionId = await insertTransaction(accountId, 'k1');

      await db.query(
        `INSERT INTO transaction_sources (transaction_id, raw_row_id, account_id) VALUES ($1, $2, $3)`,
        [transactionId, rawRowId, accountId],
      );

      const { rows } = await db.query('SELECT * FROM transaction_sources');
      expect(rows).toHaveLength(1);
    });

    it('rejects a link between a transaction and a raw row of different accounts', async () => {
      const a = await insertAccount();
      const b = await insertAccount();
      const fileId = await insertFile(a);
      const rawRowOfA = await insertRawRow(fileId, a);
      const transactionOfB = await insertTransaction(b, 'k1');

      await expect(
        db.query(
          `INSERT INTO transaction_sources (transaction_id, raw_row_id, account_id) VALUES ($1, $2, $3)`,
          [transactionOfB, rawRowOfA, b],
        ),
      ).rejects.toThrow();
      await expect(
        db.query(
          `INSERT INTO transaction_sources (transaction_id, raw_row_id, account_id) VALUES ($1, $2, $3)`,
          [transactionOfB, rawRowOfA, a],
        ),
      ).rejects.toThrow();
    });

    it('allows two raw rows to be sources of one transaction', async () => {
      const accountId = await insertAccount();
      const file1 = await insertFile(accountId, { sha256: '1' });
      const file2 = await insertFile(accountId, { sha256: '2' });
      const raw1 = await insertRawRow(file1, accountId);
      const raw2 = await insertRawRow(file2, accountId);
      const transactionId = await insertTransaction(accountId, 'k1');

      for (const raw of [raw1, raw2]) {
        await db.query(
          `INSERT INTO transaction_sources (transaction_id, raw_row_id, account_id) VALUES ($1, $2, $3)`,
          [transactionId, raw, accountId],
        );
      }

      const { rows } = await db.query('SELECT * FROM transaction_sources');
      expect(rows).toHaveLength(2);
    });
  });
});
