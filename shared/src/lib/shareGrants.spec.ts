import { parse } from 'pgsql-ast-parser';
import {
  assertCanMutateGrant,
  NotResourceOwnerError,
  ownershipPredicate,
  SHARE_GRANTS_TABLE_DDL,
  type ResourceType,
} from './shareGrants';

describe('SHARE_GRANTS_TABLE_DDL', () => {
  it('parses as a valid Postgres CREATE TABLE statement with the shape from ADR-0002', () => {
    const [statement] = parse(SHARE_GRANTS_TABLE_DDL);

    expect(statement.type).toBe('create table');
    if (statement.type !== 'create table') {
      throw new Error('expected a create table statement');
    }
    expect(statement.name.name).toBe('share_grants');
    expect(statement.columns.map((column) => column.name.name)).toEqual([
      'grantor_user_id',
      'grantee_user_id',
      'resource_type',
      'resource_id',
      'created_at',
    ]);
  });
});

describe('ownershipPredicate', () => {
  it('builds the owner-or-active-grant WHERE/EXISTS predicate from ADR-0002', () => {
    expect(ownershipPredicate('accounts', 'account')).toBe(
      "(accounts.owner_user_id = :sub OR EXISTS (SELECT 1 FROM share_grants sg WHERE sg.grantee_user_id = :sub AND sg.resource_type = 'account' AND sg.resource_id = accounts.id))",
    );
  });
});

interface Row {
  id: string;
  ownerUserId: string;
}

interface Grant {
  grantorUserId: string;
  granteeUserId: string;
  resourceType: ResourceType;
  resourceId: string;
}

// Mirrors the boolean semantics of the SQL text ownershipPredicate() returns:
// `owner_user_id = :sub OR EXISTS (an active grant to :sub for this resource)`.
function hasAccess(
  row: Row,
  grants: Grant[],
  sub: string,
  resourceType: ResourceType,
): boolean {
  if (row.ownerUserId === sub) {
    return true;
  }
  return grants.some(
    (grant) =>
      grant.granteeUserId === sub &&
      grant.resourceType === resourceType &&
      grant.resourceId === row.id,
  );
}

describe('ownership/grant access semantics', () => {
  const account: Row = { id: 'acc-1', ownerUserId: 'bob' };

  it('owner-only access: the owner sees their resource with no grants', () => {
    expect(hasAccess(account, [], 'bob', 'account')).toBe(true);
  });

  it('active-grant access: a grantee sees a resource shared with them', () => {
    const grants: Grant[] = [
      {
        grantorUserId: 'bob',
        granteeUserId: 'alice',
        resourceType: 'account',
        resourceId: 'acc-1',
      },
    ];

    expect(hasAccess(account, grants, 'alice', 'account')).toBe(true);
  });

  it('no-access-without-grant: a stranger sees nothing', () => {
    expect(hasAccess(account, [], 'stranger', 'account')).toBe(false);
  });

  it('a revoked grant (row removed) denies access on the next evaluation', () => {
    const activeGrants: Grant[] = [
      {
        grantorUserId: 'bob',
        granteeUserId: 'alice',
        resourceType: 'account',
        resourceId: 'acc-1',
      },
    ];
    expect(hasAccess(account, activeGrants, 'alice', 'account')).toBe(true);

    const afterRevoke: Grant[] = [];
    expect(hasAccess(account, afterRevoke, 'alice', 'account')).toBe(false);
  });
});

describe('assertCanMutateGrant', () => {
  it('allows the resource owner to mutate a grant', () => {
    expect(() => assertCanMutateGrant('bob', 'bob')).not.toThrow();
  });

  it('rejects a caller who is not the trusted resource owner', () => {
    expect(() => assertCanMutateGrant('bob', 'alice')).toThrow(
      NotResourceOwnerError,
    );
  });

  it('rejects even when a spoofed payload claims the caller as grantor', () => {
    // Simulates the attack this function must resist: the request body says
    // grantor_user_id = 'alice' (the caller), but the trusted owner looked up
    // from the resource's own row is 'bob' — the call site must pass the
    // trusted value, not the payload's, or this check is worthless.
    const trustedOwnerFromResourceRow = 'bob';
    const authenticatedCaller = 'alice';

    expect(() =>
      assertCanMutateGrant(trustedOwnerFromResourceRow, authenticatedCaller),
    ).toThrow(NotResourceOwnerError);
  });
});
