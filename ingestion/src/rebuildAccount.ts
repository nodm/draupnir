import { RDSDataClient } from '@aws-sdk/client-rds-data';
import { loadDataApiConfigFromEnv } from 'shared';
import { rebuildAccount, type RebuildResult } from './lib/rebuildAccount';

const dataApiClient = new RDSDataClient({});

// Internal maintenance operation, invoked by hand:
//   aws lambda invoke --function-name <rebuild-account> \
//     --payload '{"accountId":"<id>"}' --cli-binary-format raw-in-base64-out out.json
export const handler = async (event: {
  accountId?: string;
}): Promise<RebuildResult> => {
  if (!event.accountId) {
    throw new Error('Missing accountId in the event payload');
  }
  return rebuildAccount(
    dataApiClient,
    loadDataApiConfigFromEnv(),
    event.accountId,
  );
};
