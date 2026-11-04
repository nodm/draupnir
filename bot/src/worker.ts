import { RDSDataClient } from '@aws-sdk/client-rds-data';
import type { SQSHandler } from 'aws-lambda';
import type { Update } from '@grammyjs/types';
import { loadDataApiConfigFromEnv } from 'shared';
import { dispatch } from './lib/dispatcher';
import { createUnlinkHandler } from './lib/commands/unlink';
import { loadLinkConfigFromEnv } from './lib/linking/config';
import { createLinkStore } from './lib/linking/linkStore';
import { handleUnlinked } from './lib/linking/unlinked';
import { createRoutes, createSubResolver } from './lib/routes';
import { getSecretString } from './lib/secrets';
import { createTelegramClient } from './lib/telegram';

const dataApiClient = new RDSDataClient({});

// Needs `ReportBatchItemFailures` on the event source mapping. FIFO order must
// hold, so after the first failure every later record in the batch is reported
// as failed too (they are retried in order) rather than processed out of turn;
// records that already succeeded are not run again.
export const handler: SQSHandler = async (event) => {
  const botTokenArn = process.env['BOT_TOKEN_SECRET_ARN'];
  if (!botTokenArn) {
    throw new Error('Missing BOT_TOKEN_SECRET_ARN environment variable');
  }
  const telegram = createTelegramClient(await getSecretString(botTokenArn));
  const dataApiConfig = loadDataApiConfigFromEnv();
  const linking = {
    store: createLinkStore(dataApiClient, dataApiConfig),
    config: loadLinkConfigFromEnv(),
  };
  const routes = createRoutes(
    createSubResolver(dataApiClient, dataApiConfig),
    (ctx) => handleUnlinked(ctx, linking),
    { unlink: createUnlinkHandler(dataApiClient, dataApiConfig) },
  );

  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    if (batchItemFailures.length > 0) {
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }
    try {
      await dispatch(JSON.parse(record.body) as Update, telegram, routes);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'update-failed',
          messageId: record.messageId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
};
