import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import {
  executeStatement,
  withCaller,
  type DataApiConfig,
  type MemberRole,
} from 'shared';

export interface MemberAccount {
  id: string;
  bank: string;
  iban: string;
  currency: string;
  displayName: string;
  role: MemberRole;
}

// Every account the caller belongs to (RLS limits the join to their rows).
export async function listMemberAccounts(
  client: RDSDataClient,
  config: DataApiConfig,
  sub: string,
): Promise<MemberAccount[]> {
  const rows = await withCaller(
    client,
    config,
    sub,
    async (transactionId) =>
      (
        await executeStatement(
          client,
          config,
          `SELECT a.id, a.bank, a.iban, a.currency, a.display_name, m.role
           FROM account_members m JOIN accounts a ON a.id = m.account_id
          WHERE m.user_id = :sub
          ORDER BY a.display_name, a.id`,
          { sub },
          transactionId,
        )
      ).rows,
  );
  return (
    rows as {
      id: string;
      bank: string;
      iban: string;
      currency: string;
      display_name: string;
      role: MemberRole;
    }[]
  ).map((r) => ({
    id: r.id,
    bank: r.bank,
    iban: r.iban,
    currency: r.currency,
    displayName: r.display_name,
    role: r.role,
  }));
}
