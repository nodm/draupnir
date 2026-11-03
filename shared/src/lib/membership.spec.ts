// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import type { DataApiConfig } from './dataApi';
import {
  addMember,
  AlreadyMemberError,
  changeMemberRole,
  getMemberRole,
  LastOwnerError,
  memberPredicate,
  MemberNotFoundError,
  NotAccountOwnerError,
  removeMember,
} from './membership';
import { applyMigrationsForTest } from './migrations/applyMigrationsForTest';
import { createPgliteDataApiClient } from './testing/pgliteDataApiClient';

const config: DataApiConfig = {
  resourceArn: 'arn',
  secretArn: 'arn',
  database: 'db',
};

describe('memberPredicate', () => {
  it('builds the membership check for an accounts alias', () => {
    expect(memberPredicate('a', 'id')).toBe(
      'EXISTS (SELECT 1 FROM account_members m WHERE m.account_id = a.id AND m.user_id = :sub)',
    );
  });

  it('adds the owner role clause for child tables', () => {
    expect(memberPredicate('t', 'account_id', 'owner')).toBe(
      "EXISTS (SELECT 1 FROM account_members m WHERE m.account_id = t.account_id AND m.user_id = :sub AND m.role = 'owner')",
    );
  });

  it('rejects an alias that is not a plain identifier', () => {
    expect(() => memberPredicate('a; DROP TABLE x', 'id')).toThrow();
  });
});

describe('membership on a real Postgres instance', () => {
  let db: PGlite;
  let client: ReturnType<typeof createPgliteDataApiClient>['client'];
  let counter = 0;

  beforeAll(async () => {
    db = new PGlite();
    await applyMigrationsForTest(db);
    client = createPgliteDataApiClient(db).client;
  });

  afterAll(async () => {
    await db.close();
  });

  async function newAccount(members: Record<string, 'owner' | 'viewer'>) {
    counter += 1;
    const id = `acc-${counter}`;
    await db.query(
      `INSERT INTO accounts (id, bank, iban, currency, display_name, opened_on, opening_balance_minor_units)
       VALUES ($1, 'seb', $2, 'EUR', 'x', '2024-01-01', 0)`,
      [id, `LT${String(counter).padStart(18, '0')}`],
    );
    for (const [userId, role] of Object.entries(members)) {
      await db.query(
        'INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)',
        [id, userId, role],
      );
    }
    return id;
  }

  async function roles(accountId: string) {
    const { rows } = await db.query<{ user_id: string; role: string }>(
      'SELECT user_id, role FROM account_members WHERE account_id = $1 ORDER BY user_id',
      [accountId],
    );
    return Object.fromEntries(rows.map((r) => [r.user_id, r.role]));
  }

  async function visibleAccountIds(sub: string, minRole?: 'owner') {
    const { rows } = await db.query<{ id: string }>(
      `SELECT a.id FROM accounts a WHERE ${memberPredicate('a', 'id', minRole).replace(':sub', '$1')} ORDER BY a.id`,
      [sub],
    );
    return rows.map((r) => r.id);
  }

  describe('memberPredicate SQL', () => {
    it('is valid SQL for accounts and for a child table', async () => {
      const accountId = await newAccount({ 'pred-owner': 'owner' });
      await db.query(
        `INSERT INTO transactions (account_id, posted_date, amount_minor_units, currency, description, dedup_key)
         VALUES ($1, '2026-01-01', 1, 'EUR', 'd', 'k')`,
        [accountId],
      );

      const child = await db.query(
        `SELECT t.id FROM transactions t WHERE ${memberPredicate('t', 'account_id').replace(':sub', '$1')}`,
        ['pred-owner'],
      );
      const none = await db.query(
        `SELECT t.id FROM transactions t WHERE ${memberPredicate('t', 'account_id').replace(':sub', '$1')}`,
        ['stranger'],
      );

      expect(child.rows).toHaveLength(1);
      expect(none.rows).toHaveLength(0);
    });

    it('the owner role clause excludes viewers', async () => {
      const accountId = await newAccount({ po: 'owner', pv: 'viewer' });

      expect(await visibleAccountIds('pv')).toContain(accountId);
      expect(await visibleAccountIds('pv', 'owner')).not.toContain(accountId);
      expect(await visibleAccountIds('po', 'owner')).toContain(accountId);
    });
  });

  describe('grants cover only the named account', () => {
    it('a viewer of account A cannot see the owner’s other account B', async () => {
      const a = await newAccount({ own1: 'owner' });
      const b = await newAccount({ own1: 'owner' });

      await addMember(client, config, 'own1', {
        accountId: a,
        userId: 'friend1',
        role: 'viewer',
      });

      const visible = await visibleAccountIds('friend1');
      expect(visible).toContain(a);
      expect(visible).not.toContain(b);
    });
  });

  describe('only an owner may change membership', () => {
    it('owner adds a member', async () => {
      const a = await newAccount({ own2: 'owner' });

      await addMember(client, config, 'own2', {
        accountId: a,
        userId: 'new2',
        role: 'viewer',
      });

      expect(await roles(a)).toEqual({ new2: 'viewer', own2: 'owner' });
    });

    it('a viewer cannot add a member', async () => {
      const a = await newAccount({ own3: 'owner', view3: 'viewer' });

      await expect(
        addMember(client, config, 'view3', {
          accountId: a,
          userId: 'new3',
          role: 'viewer',
        }),
      ).rejects.toBeInstanceOf(NotAccountOwnerError);
      expect(await roles(a)).toEqual({ own3: 'owner', view3: 'viewer' });
    });

    it('a non-member cannot add a member', async () => {
      const a = await newAccount({ own4: 'owner' });

      await expect(
        addMember(client, config, 'stranger4', {
          accountId: a,
          userId: 'stranger4',
          role: 'owner',
        }),
      ).rejects.toBeInstanceOf(NotAccountOwnerError);
      expect(await roles(a)).toEqual({ own4: 'owner' });
    });

    it('a viewer cannot remove or re-role members', async () => {
      const a = await newAccount({ own5: 'owner', view5: 'viewer' });

      await expect(
        removeMember(client, config, 'view5', { accountId: a, userId: 'own5' }),
      ).rejects.toBeInstanceOf(NotAccountOwnerError);
      await expect(
        changeMemberRole(client, config, 'view5', {
          accountId: a,
          userId: 'view5',
          role: 'owner',
        }),
      ).rejects.toBeInstanceOf(NotAccountOwnerError);
      expect(await roles(a)).toEqual({ own5: 'owner', view5: 'viewer' });
    });

    it('adding an existing member is rejected', async () => {
      const a = await newAccount({ own6: 'owner', view6: 'viewer' });

      await expect(
        addMember(client, config, 'own6', {
          accountId: a,
          userId: 'view6',
          role: 'owner',
        }),
      ).rejects.toBeInstanceOf(AlreadyMemberError);
    });

    it('changing or removing a non-member is rejected', async () => {
      const a = await newAccount({ own7: 'owner' });

      await expect(
        removeMember(client, config, 'own7', { accountId: a, userId: 'nobody' }),
      ).rejects.toBeInstanceOf(MemberNotFoundError);
      await expect(
        changeMemberRole(client, config, 'own7', {
          accountId: a,
          userId: 'nobody',
          role: 'viewer',
        }),
      ).rejects.toBeInstanceOf(MemberNotFoundError);
    });
  });

  describe('last-owner rule', () => {
    it('rejects removing the only owner', async () => {
      const a = await newAccount({ own8: 'owner', view8: 'viewer' });

      await expect(
        removeMember(client, config, 'own8', { accountId: a, userId: 'own8' }),
      ).rejects.toBeInstanceOf(LastOwnerError);
      expect(await roles(a)).toEqual({ own8: 'owner', view8: 'viewer' });
    });

    it('rejects demoting the only owner', async () => {
      const a = await newAccount({ own9: 'owner' });

      await expect(
        changeMemberRole(client, config, 'own9', {
          accountId: a,
          userId: 'own9',
          role: 'viewer',
        }),
      ).rejects.toBeInstanceOf(LastOwnerError);
      expect(await roles(a)).toEqual({ own9: 'owner' });
    });

    it('allows removing an owner when another owner remains', async () => {
      const a = await newAccount({ own10: 'owner', own10b: 'owner' });

      await removeMember(client, config, 'own10', {
        accountId: a,
        userId: 'own10b',
      });

      expect(await roles(a)).toEqual({ own10: 'owner' });
    });

    it('allows promoting then demoting so ownership transfers', async () => {
      const a = await newAccount({ own11: 'owner', view11: 'viewer' });

      await changeMemberRole(client, config, 'own11', {
        accountId: a,
        userId: 'view11',
        role: 'owner',
      });
      await changeMemberRole(client, config, 'own11', {
        accountId: a,
        userId: 'own11',
        role: 'viewer',
      });

      expect(await roles(a)).toEqual({ own11: 'viewer', view11: 'owner' });
    });
  });

  describe('revocation and owner access', () => {
    it('a removed member is denied on the very next read', async () => {
      const a = await newAccount({ own12: 'owner' });
      await addMember(client, config, 'own12', {
        accountId: a,
        userId: 'friend12',
        role: 'viewer',
      });
      expect(await visibleAccountIds('friend12')).toContain(a);

      await removeMember(client, config, 'own12', {
        accountId: a,
        userId: 'friend12',
      });

      expect(await visibleAccountIds('friend12')).not.toContain(a);
      expect(await getMemberRole(client, config, a, 'friend12')).toBeNull();
    });

    it('an owner with no other members still has access', async () => {
      const a = await newAccount({ own13: 'owner' });

      expect(await visibleAccountIds('own13')).toContain(a);
      expect(await getMemberRole(client, config, a, 'own13')).toBe('owner');
    });

    it('getMemberRole distinguishes viewer from owner', async () => {
      const a = await newAccount({ own14: 'owner', view14: 'viewer' });

      expect(await getMemberRole(client, config, a, 'view14')).toBe('viewer');
    });
  });
});
