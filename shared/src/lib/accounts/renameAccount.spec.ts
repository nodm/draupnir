// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import type { DataApiConfig } from '../dataApi';
import { applyMigrationsForTest } from '../migrations/applyMigrationsForTest';
import { NotAccountOwnerError } from '../membership';
import { createPgliteDataApiClient } from '../testing/pgliteDataApiClient';
import { InvalidAccountInputError } from './createAccount';
import {
  MAX_DISPLAY_NAME_LENGTH,
  normalizeDisplayName,
  renameAccount,
} from './renameAccount';

const config: DataApiConfig = {
  resourceArn: 'arn:aws:rds:eu-north-1:123:cluster:test',
  secretArn: 'arn:aws:secretsmanager:eu-north-1:123:secret:test',
  database: 'draupnir',
};

let db: PGlite;
let client: ReturnType<typeof createPgliteDataApiClient>['client'];

beforeAll(async () => {
  db = new PGlite();
  await applyMigrationsForTest(db);
  client = createPgliteDataApiClient(db, { role: 'draupnir_app' }).client;
  await db.exec(`
    INSERT INTO accounts (id, bank, iban, currency, display_name, opened_on, opening_balance_minor_units) VALUES
      ('a1', 'seb', 'LT000000000000000001', 'EUR', 'Old name', '2026-01-01', 0);
    INSERT INTO account_members (account_id, user_id, role) VALUES
      ('a1', 'owner', 'owner'), ('a1', 'viewer', 'viewer');
  `);
}, 60_000);

afterAll(async () => {
  await db.close();
});

const nameOf = async () =>
  (
    await db.query<{ display_name: string }>(
      `SELECT display_name FROM accounts WHERE id = 'a1'`,
    )
  ).rows[0]?.display_name;

describe('normalizeDisplayName', () => {
  it('trims, and refuses empty or too-long names', () => {
    expect(normalizeDisplayName('  Salary ')).toBe('Salary');
    expect(normalizeDisplayName('   ')).toBeNull();
    expect(
      normalizeDisplayName('x'.repeat(MAX_DISPLAY_NAME_LENGTH)),
    ).not.toBeNull();
    expect(
      normalizeDisplayName('x'.repeat(MAX_DISPLAY_NAME_LENGTH + 1)),
    ).toBeNull();
  });
});

describe('renameAccount', () => {
  it('lets an owner rename, returning the old name', async () => {
    const result = await renameAccount(client, config, 'owner', {
      accountId: 'a1',
      displayName: ' Salary ',
    });
    expect(result).toEqual({ oldName: 'Old name', newName: 'Salary' });
    expect(await nameOf()).toBe('Salary');
  });

  it.each(['viewer', 'stranger'])('rejects %s', async (sub) => {
    await expect(
      renameAccount(client, config, sub, {
        accountId: 'a1',
        displayName: 'Hacked',
      }),
    ).rejects.toThrow(NotAccountOwnerError);
    expect(await nameOf()).toBe('Salary');
  });

  it.each(['', '   ', 'x'.repeat(61)])(
    'rejects invalid name %j',
    async (displayName) => {
      await expect(
        renameAccount(client, config, 'owner', {
          accountId: 'a1',
          displayName,
        }),
      ).rejects.toThrow(InvalidAccountInputError);
      expect(await nameOf()).toBe('Salary');
    },
  );
});
