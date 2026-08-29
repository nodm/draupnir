export const SHARE_GRANTS_TABLE_DDL = `
CREATE TABLE share_grants (
  grantor_user_id text NOT NULL,
  grantee_user_id text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (grantee_user_id, resource_type, resource_id)
);
`.trim();

export type ResourceType = 'account' | 'category';

export function ownershipPredicate(
  tableAlias: string,
  resourceType: ResourceType,
): string {
  return `(${tableAlias}.owner_user_id = :sub OR EXISTS (SELECT 1 FROM share_grants sg WHERE sg.grantee_user_id = :sub AND sg.resource_type = '${resourceType}' AND sg.resource_id = ${tableAlias}.id))`;
}

export class NotResourceOwnerError extends Error {
  constructor() {
    super('Only a resource owner may create or revoke a share grant for it');
    this.name = 'NotResourceOwnerError';
  }
}

// `trustedResourceOwnerUserId` must come from a `SELECT owner_user_id` against
// the resource's own table, never from the grant payload's `grantor_user_id` —
// that field is caller-supplied and proves nothing about actual ownership.
export function assertCanMutateGrant(
  trustedResourceOwnerUserId: string,
  authenticatedSub: string,
): void {
  if (trustedResourceOwnerUserId !== authenticatedSub) {
    throw new NotResourceOwnerError();
  }
}
