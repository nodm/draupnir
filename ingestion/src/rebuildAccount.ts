import { RDSDataClient } from '@aws-sdk/client-rds-data';
import { loadDataApiConfigFromEnv } from 'shared';
import { rebuildAccount, type RebuildResult } from './lib/rebuildAccount';

const dataApiClient = new RDSDataClient({});

// Internal maintenance operation, invoked by hand:
//   aws lambda invoke --function-name <rebuild-account> \
//     --payload '{"sub":"<owner sub>","accountId":"<id>"}' --cli-binary-format raw-in-base64-out out.json
// `sub` must be an owner of the account: row-level security applies to this
// handler like any other.
export const handler = async (event: {
  sub?: string;
  accountId?: string;
}): Promise<RebuildResult> => {
  if (!event.accountId || !event.sub) {
    throw new Error('Missing sub or accountId in the event payload');
  }
  return rebuildAccount(
    dataApiClient,
    loadDataApiConfigFromEnv(),
    event.sub,
    event.accountId,
  );
};
