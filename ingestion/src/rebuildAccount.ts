import { RDSDataClient } from '@aws-sdk/client-rds-data';
import { loadDataApiConfigFromEnv } from 'shared';
import {
  backfillAccountBalances,
  type BackfillResult,
} from './lib/backfillAccountBalances';
import { rebuildAccount, type RebuildResult } from './lib/rebuildAccount';

const dataApiClient = new RDSDataClient({});
const MODES: readonly unknown[] = ['rebuild', 'backfill'];

// Internal maintenance operation, invoked by hand:
//   aws lambda invoke --function-name <rebuild-account> \
//     --payload '{"sub":"<owner sub>","accountId":"<id>"}' --cli-binary-format raw-in-base64-out out.json
// `sub` must be an owner of the account: row-level security applies to this
// handler like any other.
//
// With "mode":"backfill" it instead fills an existing account's order keys,
// running balances and balance in place, keeping every transaction row (see
// docs/adr/0013-stored-account-balances.md). Safe to run again.
export const handler = async (event: {
  sub?: string;
  accountId?: string;
  mode?: 'rebuild' | 'backfill';
}): Promise<RebuildResult | BackfillResult> => {
  if (!event.accountId || !event.sub) {
    throw new Error('Missing sub or accountId in the event payload');
  }
  // Rebuild deletes and re-inserts transactions, so a mistyped mode must fail,
  // never fall through to it.
  if (event.mode !== undefined && !MODES.includes(event.mode)) {
    throw new Error(
      `Unknown mode ${JSON.stringify(event.mode)}; expected "rebuild" or "backfill"`,
    );
  }
  if (event.mode === 'backfill') {
    return backfillAccountBalances(
      dataApiClient,
      loadDataApiConfigFromEnv(),
      event.sub,
      event.accountId,
    );
  }
  return rebuildAccount(
    dataApiClient,
    loadDataApiConfigFromEnv(),
    event.sub,
    event.accountId,
  );
};
