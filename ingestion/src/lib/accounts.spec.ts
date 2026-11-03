// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import {
  applyMigrationsForTest,
  createPgliteDataApiClient,
  type DataApiConfig,
} from 'shared';
import {
  createAccount,
  DuplicateIbanError,
  InvalidAccountInputError,
  InvalidBankError,
} from './accounts';
import { UnauthenticatedError } from './auth';

const config: DataApiConfig = {
  resourceArn: 'arn:aws:rds:eu-north-1:123:cluster:test',
  secretArn: 'arn:aws:secretsmanager:eu-north-1:123:secret:test',
  database: 'draupnir',
};

const validInput = {
  bank: 'seb',
  iban: 'LT121000011101001000',
  currency: 'EUR',
  displayName: 'SEB checking',
  openedOn: '2024-01-15',
  openingBalanceMinorUnits: 0,
};

function neverCalledClient() {
  const send = vi.fn();
  return { send, client: { send } as unknown as RDSDataClient };
}

describe('createAccount validation (no database access)', () => {
  it('rejects when the caller has no sub claim', async () => {
    const { send, client } = neverCalledClient();

    await expect(createAccount(client, config, {}, validInput)).rejects.toThrow(
      UnauthenticatedError,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects an unknown bank value', async () => {
    const { send, client } = neverCalledClient();

    await expect(
      createAccount(
        client,
        config,
        { sub: 'u' },
        { ...validInput, bank: 'chase' },
      ),
    ).rejects.toThrow(InvalidBankError);
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['iban', 'currency', 'displayName'] as const)(
    'rejects an empty %s',
    async (field) => {
      const { send, client } = neverCalledClient();

      await expect(
        createAccount(
          client,
          config,
          { sub: 'u' },
          { ...validInput, [field]: '  ' },
        ),
      ).rejects.toThrow(InvalidAccountInputError);
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each(['LT10-0000-0000-0000-0001', 'LT000000000000000000'])(
    'rejects the invalid iban %s',
    async (iban) => {
      const { send, client } = neverCalledClient();

      await expect(
        createAccount(client, config, { sub: 'u' }, { ...validInput, iban }),
      ).rejects.toThrow(InvalidAccountInputError);
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each(['EURO', 'E1R', 'euros', '€'])(
    'rejects the non-ISO currency %j',
    async (currency) => {
      const { send, client } = neverCalledClient();

      await expect(
        createAccount(
          client,
          config,
          { sub: 'u' },
          { ...validInput, currency },
        ),
      ).rejects.toThrow(InvalidAccountInputError);
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['openedOn', '15/01/2024'],
    ['openedOn', '2024-02-31'],
    ['openedOn', undefined],
    ['openingBalanceMinorUnits', 10.5],
    ['openingBalanceMinorUnits', '100'],
    ['openingBalanceMinorUnits', undefined],
  ])('rejects %s = %s', async (field, value) => {
    const { send, client } = neverCalledClient();

    await expect(
      createAccount(client, config, { sub: 'u' }, {
        ...validInput,
        [field]: value,
      } as never),
    ).rejects.toThrow(InvalidAccountInputError);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('createAccount on a real Postgres instance', () => {
  let db: PGlite;
  let client: RDSDataClient;

  beforeAll(async () => {
    db = new PGlite();
    await applyMigrationsForTest(db);
    client = createPgliteDataApiClient(db).client;
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.exec('TRUNCATE account_members, accounts CASCADE');
  });

  it('creates the account with its opening balance and records the caller as owner', async () => {
    const account = await createAccount(
      client,
      config,
      { sub: 'user-123' },
      validInput,
    );

    expect(account).toEqual({ id: expect.any(String), ...validInput });
    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT a.bank, a.iban, a.opened_on::text AS opened_on, a.opening_balance_minor_units::text AS opening,
              m.user_id, m.role
         FROM accounts a JOIN account_members m ON m.account_id = a.id`,
    );
    expect(rows).toEqual([
      {
        bank: 'seb',
        iban: 'LT121000011101001000',
        opened_on: '2024-01-15',
        opening: '0',
        user_id: 'user-123',
        role: 'owner',
      },
    ]);
  });

  it('takes the owner from the authenticated identity only', async () => {
    await createAccount(client, config, { sub: 'real-user' }, {
      ...validInput,
      userId: 'attacker',
      ownerUserId: 'attacker',
    } as never);

    const { rows } = await db.query<{ user_id: string }>(
      'SELECT user_id FROM account_members',
    );
    expect(rows).toEqual([{ user_id: 'real-user' }]);
  });

  it('stores a negative opening balance', async () => {
    await createAccount(
      client,
      config,
      { sub: 'u' },
      { ...validInput, openingBalanceMinorUnits: -12550 },
    );

    const { rows } = await db.query<{ v: string }>(
      'SELECT opening_balance_minor_units::text AS v FROM accounts',
    );
    expect(rows[0]?.v).toBe('-12550');
  });

  it.each([' eur ', 'eur'])(
    'stores the canonical currency for %j',
    async (currency) => {
      const account = await createAccount(
        client,
        config,
        { sub: 'u' },
        { ...validInput, currency },
      );

      expect(account.currency).toBe('EUR');
      const { rows } = await db.query<{ currency: string }>(
        'SELECT currency FROM accounts',
      );
      expect(rows[0]?.currency).toBe('EUR');
    },
  );

  it('canonicalizes a lowercase, spaced iban', async () => {
    const account = await createAccount(
      client,
      config,
      { sub: 'u' },
      { ...validInput, iban: 'lt12 1000 0111 0100 1000' },
    );

    expect(account.iban).toBe('LT121000011101001000');
  });

  it('rejects a duplicate iban, telling the caller to ask an owner, and creates nothing new', async () => {
    await createAccount(client, config, { sub: 'first' }, validInput);

    const attempt = createAccount(
      client,
      config,
      { sub: 'second' },
      validInput,
    );

    await expect(attempt).rejects.toThrow(DuplicateIbanError);
    await expect(attempt).rejects.toThrow(/ask one of its owners to add you/);
    expect((await db.query('SELECT * FROM accounts')).rows).toHaveLength(1);
    const members = await db.query<{ user_id: string }>(
      'SELECT user_id FROM account_members',
    );
    expect(members.rows).toEqual([{ user_id: 'first' }]);
  });

  it('creates no account when the membership insert fails', async () => {
    const real = client;
    const failing = {
      send: async (command: { input: { sql?: string } }) => {
        if (command.input.sql?.includes('INSERT INTO account_members')) {
          throw new Error('membership failed');
        }
        return real.send(command as never);
      },
    } as unknown as RDSDataClient;

    await expect(
      createAccount(failing, config, { sub: 'u' }, validInput),
    ).rejects.toThrow('membership failed');

    expect((await db.query('SELECT * FROM accounts')).rows).toHaveLength(0);
  });
});
