import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import { executeStatement, type DataApiConfig } from '../dataApi';
import { computeCoverage, loadSegments } from './coverage';

export interface AccountBalance {
  balanceMinorUnits: number;
  // The day the balance last changed: the date of the latest transaction's
  // `occurred_at`, or the opening date when there are none.
  balanceAsOf: string;
  // History is continuous from the opening balance (or there is none yet).
  reconciled: boolean;
}

export class BalanceAccountNotFoundError extends Error {
  constructor(accountId: string) {
    super(`Account not found: ${accountId}`);
    this.name = 'BalanceAccountNotFoundError';
  }
}

// Recomputes one account's running balances and its stored balance from the
// stored transactions, inside the caller's transaction. It is always a full
// recompute, never an increment, so a retry or a duplicate import cannot drift
// it. The caller holds the account's `FOR UPDATE` lock (imports, rebuild and
// the backfill all take it), which serializes this with every other writer.
//
// No backslashes in the SQL: the Data API's parameter parser breaks on them.
export async function recomputeAccountBalance(
  client: RDSDataClient,
  config: DataApiConfig,
  transactionId: string,
  accountId: string,
): Promise<AccountBalance> {
  const { rows: accountRows } = await executeStatement(
    client,
    config,
    `SELECT currency, CAST(opened_on AS text) AS opened_on, opening_balance_minor_units
       FROM accounts WHERE id = :accountId`,
    { accountId },
    transactionId,
  );
  const account = accountRows[0] as
    | {
        currency: string;
        opened_on: string;
        opening_balance_minor_units: number;
      }
    | undefined;
  if (!account) throw new BalanceAccountNotFoundError(accountId);

  // Only rows whose balance changed are written, so a repeat is a no-op.
  await executeStatement(
    client,
    config,
    `UPDATE transactions t
        SET running_balance_minor_units = CAST(r.balance AS bigint)
       FROM (SELECT x.id,
                    a.opening_balance_minor_units
                      + SUM(x.amount_minor_units - x.fee_minor_units)
                          OVER (ORDER BY x.occurred_at, x.source_seq, x.id) AS balance
               FROM transactions x
               JOIN accounts a ON a.id = x.account_id
              WHERE x.account_id = :accountId) r
      WHERE t.id = r.id AND t.account_id = :accountId
        AND t.running_balance_minor_units IS DISTINCT FROM CAST(r.balance AS bigint)`,
    { accountId },
    transactionId,
  );

  const segments = await loadSegments(client, config, accountId, transactionId);
  const coverage = computeCoverage(
    {
      currency: account.currency,
      openedOn: account.opened_on,
      openingBalanceMinorUnits: account.opening_balance_minor_units,
    },
    segments,
  );
  const reconciled =
    segments.length === 0 ||
    (coverage.connectsToOpening === 'continuous' &&
      coverage.links.every((link) => link.continuity === 'continuous'));

  const { rows } = await executeStatement(
    client,
    config,
    `UPDATE accounts a
        SET balance_minor_units = CAST(a.opening_balance_minor_units + COALESCE(s.total, 0) AS bigint),
            balance_as_of = COALESCE(s.last_day, a.opened_on),
            balance_reconciled = :reconciled
       FROM (SELECT SUM(amount_minor_units - fee_minor_units) AS total,
                    CAST(MAX(occurred_at) AT TIME ZONE 'UTC' AS date) AS last_day
               FROM transactions WHERE account_id = :accountId) s
      WHERE a.id = :accountId
  RETURNING a.balance_minor_units, CAST(a.balance_as_of AS text) AS balance_as_of`,
    { accountId, reconciled },
    transactionId,
  );
  const stored = rows[0] as {
    balance_minor_units: number;
    balance_as_of: string;
  };
  return {
    balanceMinorUnits: stored.balance_minor_units,
    balanceAsOf: stored.balance_as_of,
    reconciled,
  };
}
