import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import { executeStatement, withCaller, type DataApiConfig } from '../dataApi';
import { NotAccountOwnerError } from '../membership';
import { InvalidAccountInputError } from './createAccount';

export const MAX_DISPLAY_NAME_LENGTH = 60;

// Trimmed name, or null when it is empty or too long.
export function normalizeDisplayName(value: string): string | null {
  const name = value.trim();
  return name.length > 0 && name.length <= MAX_DISPLAY_NAME_LENGTH
    ? name
    : null;
}

// Owner-only: the accounts_update RLS policy matches no row for anyone else,
// so zero updated rows means "not an owner of this account". Returns the old
// name (read in the same statement, before the update).
export async function renameAccount(
  client: RDSDataClient,
  config: DataApiConfig,
  sub: string,
  input: { accountId: string; displayName: string },
): Promise<{ oldName: string; newName: string }> {
  const newName = normalizeDisplayName(input.displayName);
  if (newName === null) throw new InvalidAccountInputError('displayName');

  const rows = await withCaller(
    client,
    config,
    sub,
    async (transactionId) =>
      (
        await executeStatement(
          client,
          config,
          `UPDATE accounts a SET display_name = :name
             FROM accounts o
            WHERE a.id = :accountId AND o.id = a.id
        RETURNING o.display_name AS old_name`,
          { name: newName, accountId: input.accountId },
          transactionId,
        )
      ).rows,
  );
  const row = rows[0] as { old_name: string } | undefined;
  if (!row) throw new NotAccountOwnerError();
  return { oldName: row.old_name, newName };
}
