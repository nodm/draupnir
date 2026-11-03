import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import { executeStatement, withCaller, type DataApiConfig } from './dataApi';

export type MemberRole = 'owner' | 'viewer';

// 'id' for an `accounts` alias, 'account_id' for every account-scoped child
// table. A closed union: never interpolate caller input here.
export type AccountIdColumn = 'id' | 'account_id';

const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Predicate (bound parameter `:sub`) that is true when the caller is a member
// of the row's account with at least `minRole`.
export function memberPredicate(
  tableAlias: string,
  accountIdColumn: AccountIdColumn,
  minRole: MemberRole = 'viewer',
): string {
  if (!SQL_IDENTIFIER.test(tableAlias)) {
    throw new Error(`Invalid table alias: ${tableAlias}`);
  }
  const roleClause = minRole === 'owner' ? " AND m.role = 'owner'" : '';
  return `EXISTS (SELECT 1 FROM account_members m WHERE m.account_id = ${tableAlias}.${accountIdColumn} AND m.user_id = :sub${roleClause})`;
}

export class NotAccountOwnerError extends Error {
  constructor() {
    super('Only an owner of the account may change its membership');
    this.name = 'NotAccountOwnerError';
  }
}

export class LastOwnerError extends Error {
  constructor() {
    super('An account must keep at least one owner');
    this.name = 'LastOwnerError';
  }
}

export class AlreadyMemberError extends Error {
  constructor() {
    super('The user is already a member of this account');
    this.name = 'AlreadyMemberError';
  }
}

export class MemberNotFoundError extends Error {
  constructor() {
    super('The user is not a member of this account');
    this.name = 'MemberNotFoundError';
  }
}

interface MemberRow {
  user_id: string;
  role: MemberRole;
}

// Membership is re-read on every call; nothing is cached, so a removal takes
// effect on the very next request. Without a transaction it runs as `userId`
// (a member can always read their own membership row).
export async function getMemberRole(
  client: RDSDataClient,
  config: DataApiConfig,
  accountId: string,
  userId: string,
  transactionId?: string,
): Promise<MemberRole | null> {
  const read = async (tx: string): Promise<MemberRole | null> => {
    const { rows } = await executeStatement(
      client,
      config,
      'SELECT role FROM account_members WHERE account_id = :accountId AND user_id = :userId',
      { accountId, userId },
      tx,
    );
    return rows.length === 0 ? null : (rows[0] as { role: MemberRole }).role;
  };
  return transactionId === undefined
    ? withCaller(client, config, userId, read)
    : read(transactionId);
}

// Runs `change` with the account's member rows locked (SELECT … FOR UPDATE),
// so concurrent membership changes serialize and the last-owner rule can't be
// raced past. Only an owner may change membership.
async function withLockedMembers<T>(
  client: RDSDataClient,
  config: DataApiConfig,
  actingUserId: string,
  accountId: string,
  change: (members: MemberRow[], transactionId: string) => Promise<T>,
): Promise<T> {
  return withCaller(client, config, actingUserId, async (transactionId) => {
    // FOR UPDATE also applies the owner-only UPDATE policy, so a non-owner
    // locks (and sees) nothing and is refused below.
    const { rows } = await executeStatement(
      client,
      config,
      'SELECT user_id, role FROM account_members WHERE account_id = :accountId FOR UPDATE',
      { accountId },
      transactionId,
    );
    const members = rows as unknown as MemberRow[];
    const actor = members.find((m) => m.user_id === actingUserId);
    if (actor?.role !== 'owner') {
      throw new NotAccountOwnerError();
    }
    return change(members, transactionId);
  });
}

function ownerCount(members: readonly MemberRow[]): number {
  return members.filter((m) => m.role === 'owner').length;
}

export async function addMember(
  client: RDSDataClient,
  config: DataApiConfig,
  actingUserId: string,
  input: { accountId: string; userId: string; role: MemberRole },
): Promise<void> {
  await withLockedMembers(
    client,
    config,
    actingUserId,
    input.accountId,
    async (members, transactionId) => {
      if (members.some((m) => m.user_id === input.userId)) {
        throw new AlreadyMemberError();
      }
      await executeStatement(
        client,
        config,
        'INSERT INTO account_members (account_id, user_id, role) VALUES (:accountId, :userId, :role)',
        { accountId: input.accountId, userId: input.userId, role: input.role },
        transactionId,
      );
    },
  );
}

export async function removeMember(
  client: RDSDataClient,
  config: DataApiConfig,
  actingUserId: string,
  input: { accountId: string; userId: string },
): Promise<void> {
  await withLockedMembers(
    client,
    config,
    actingUserId,
    input.accountId,
    async (members, transactionId) => {
      const target = members.find((m) => m.user_id === input.userId);
      if (!target) {
        throw new MemberNotFoundError();
      }
      if (target.role === 'owner' && ownerCount(members) === 1) {
        throw new LastOwnerError();
      }
      await executeStatement(
        client,
        config,
        'DELETE FROM account_members WHERE account_id = :accountId AND user_id = :userId',
        { accountId: input.accountId, userId: input.userId },
        transactionId,
      );
    },
  );
}

export async function changeMemberRole(
  client: RDSDataClient,
  config: DataApiConfig,
  actingUserId: string,
  input: { accountId: string; userId: string; role: MemberRole },
): Promise<void> {
  await withLockedMembers(
    client,
    config,
    actingUserId,
    input.accountId,
    async (members, transactionId) => {
      const target = members.find((m) => m.user_id === input.userId);
      if (!target) {
        throw new MemberNotFoundError();
      }
      if (
        target.role === 'owner' &&
        input.role !== 'owner' &&
        ownerCount(members) === 1
      ) {
        throw new LastOwnerError();
      }
      await executeStatement(
        client,
        config,
        'UPDATE account_members SET role = :role WHERE account_id = :accountId AND user_id = :userId',
        { accountId: input.accountId, userId: input.userId, role: input.role },
        transactionId,
      );
    },
  );
}
