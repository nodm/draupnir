// @vitest-environment node
// pglite's WASM/fs loading relies on the real Node fetch/Response, which
// jsdom (this project's default test environment) does not implement.
import { parse } from 'pgsql-ast-parser';
import { PGlite } from '@electric-sql/pglite';
import {
  ACCOUNTS_TABLE_DDL,
  TRANSACTIONS_TABLE_DDL,
} from './transactionsSchema';

describe('ACCOUNTS_TABLE_DDL', () => {
  it('parses as a valid Postgres CREATE TABLE statement', () => {
    const [statement] = parse(ACCOUNTS_TABLE_DDL);

    expect(statement.type).toBe('create table');
    if (statement.type !== 'create table') {
      throw new Error('expected a create table statement');
    }
    expect(statement.name.name).toBe('accounts');
    expect(statement.columns.map((column) => column.name.name)).toEqual([
      'id',
      'owner_user_id',
      'bank',
      'iban',
      'currency',
      'display_name',
      'created_at',
    ]);
  });
});

describe('TRANSACTIONS_TABLE_DDL', () => {
  it('parses as a valid Postgres CREATE TABLE statement', () => {
    const [statement] = parse(TRANSACTIONS_TABLE_DDL);

    expect(statement.type).toBe('create table');
    if (statement.type !== 'create table') {
      throw new Error('expected a create table statement');
    }
    expect(statement.name.name).toBe('transactions');
    expect(statement.columns.map((column) => column.name.name)).toEqual([
      'id',
      'owner_user_id',
      'account_id',
      'posted_date',
      'amount_minor_units',
      'currency',
      'description',
      'dedup_key',
      'original_currency',
      'original_amount_minor_units',
      'fx_fee_minor_units',
      'fx_fee_percent',
      'created_at',
    ]);
  });
});

describe('schema applied to a real Postgres instance', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = new PGlite();
    await db.exec(ACCOUNTS_TABLE_DDL);
    await db.exec(TRANSACTIONS_TABLE_DDL);
  });

  afterEach(async () => {
    await db.close();
  });

  async function insertAccount(overrides?: {
    iban?: string;
    bank?: string;
  }): Promise<string> {
    const result = await db.query<{ id: string }>(
      `INSERT INTO accounts (owner_user_id, bank, iban, currency, display_name)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        'user-1',
        overrides?.bank ?? 'seb',
        overrides?.iban ?? 'LT100000000000000001',
        'EUR',
        'SEB checking',
      ],
    );
    return result.rows[0].id;
  }

  describe('accounts', () => {
    it('inserts a valid row', async () => {
      const id = await insertAccount();
      expect(id).toBeTruthy();
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
  });

  describe('transactions', () => {
    async function insertTransaction(
      accountId: string,
      dedupKey: string,
      fx?: {
        ownerUserId?: string;
        originalCurrency?: string | null;
        originalAmountMinorUnits?: number | null;
        fxFeeMinorUnits?: number | null;
        fxFeePercent?: number | null;
      },
    ) {
      return db.query(
        `INSERT INTO transactions
           (owner_user_id, account_id, posted_date, amount_minor_units, currency, description, dedup_key,
            original_currency, original_amount_minor_units, fx_fee_minor_units, fx_fee_percent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (dedup_key) DO NOTHING`,
        [
          fx?.ownerUserId ?? 'user-1',
          accountId,
          '2026-08-29',
          -1050,
          'EUR',
          'lidl',
          dedupKey,
          fx?.originalCurrency ?? null,
          fx?.originalAmountMinorUnits ?? null,
          fx?.fxFeeMinorUnits ?? null,
          fx?.fxFeePercent ?? null,
        ],
      );
    }

    it('rejects a transaction whose owner_user_id does not match its account owner', async () => {
      const accountId = await insertAccount();

      await expect(
        insertTransaction(accountId, 'seb:RO1000000001L01', {
          ownerUserId: 'user-2',
        }),
      ).rejects.toThrow();
    });

    it('a duplicate dedup_key insert is a no-op', async () => {
      const accountId = await insertAccount();

      await insertTransaction(accountId, 'seb:RO1000000001L01');
      await insertTransaction(accountId, 'seb:RO1000000001L01');

      const { rows } = await db.query('SELECT * FROM transactions');
      expect(rows).toHaveLength(1);
    });

    it('distinct dedup_keys both persist', async () => {
      const accountId = await insertAccount();

      await insertTransaction(accountId, 'seb:RO1000000001L01');
      await insertTransaction(accountId, 'seb:RO1000000002L01');

      const { rows } = await db.query('SELECT * FROM transactions');
      expect(rows).toHaveLength(2);
    });

    it('FX metadata columns default to null', async () => {
      const accountId = await insertAccount();

      await insertTransaction(accountId, 'seb:RO1000000001L01');

      const { rows } = await db.query<{
        original_currency: string | null;
        original_amount_minor_units: number | null;
        fx_fee_minor_units: number | null;
        fx_fee_percent: number | null;
      }>('SELECT * FROM transactions');
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
        insertTransaction(accountId, 'seb:RO1000000001L01', {
          originalCurrency: 'NOK',
        }),
      ).rejects.toThrow();
    });

    it('rejects original_amount_minor_units set without original_currency', async () => {
      const accountId = await insertAccount();

      await expect(
        insertTransaction(accountId, 'seb:RO1000000001L01', {
          originalAmountMinorUnits: 29900,
        }),
      ).rejects.toThrow();
    });

    it('rejects fx_fee_minor_units set without fx_fee_percent', async () => {
      const accountId = await insertAccount();

      await expect(
        insertTransaction(accountId, 'seb:RO1000000001L01', {
          fxFeeMinorUnits: 68,
        }),
      ).rejects.toThrow();
    });

    it('rejects fx_fee_percent set without fx_fee_minor_units', async () => {
      const accountId = await insertAccount();

      await expect(
        insertTransaction(accountId, 'seb:RO1000000001L01', {
          fxFeePercent: 2.65,
        }),
      ).rejects.toThrow();
    });

    it('accepts all four FX metadata columns set together', async () => {
      const accountId = await insertAccount();

      await insertTransaction(accountId, 'seb:RO1000000001L01', {
        originalCurrency: 'NOK',
        originalAmountMinorUnits: 29900,
        fxFeeMinorUnits: 68,
        fxFeePercent: 2.65,
      });

      const { rows } = await db.query('SELECT * FROM transactions');
      expect(rows).toHaveLength(1);
    });
  });
});
