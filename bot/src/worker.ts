import { RDSDataClient } from '@aws-sdk/client-rds-data';
import { S3Client } from '@aws-sdk/client-s3';
import type { SQSHandler } from 'aws-lambda';
import type { Update } from '@grammyjs/types';
import { isOutcomeMessage, loadDataApiConfigFromEnv } from 'shared';
import { dispatch, HELP_TEXT, type Routes } from './lib/dispatcher';
import {
  COVERAGE_CALLBACK_PREFIX,
  createAccountsHandler,
  createCoverageHandler,
  handleCoverageCallback,
} from './lib/commands/accounts';
import {
  BANK_CALLBACK_PREFIX,
  CONFIRM_CALLBACK_PREFIX,
  createCancelHandler,
  createNewAccountHandler,
  handleNewAccountCallback,
  handleNewAccountText,
} from './lib/commands/newAccount';
import { createUnlinkHandler } from './lib/commands/unlink';
import { loadLinkConfigFromEnv } from './lib/linking/config';
import { createLinkStore } from './lib/linking/linkStore';
import { handleUnlinked } from './lib/linking/unlinked';
import {
  handleDocument,
  handleUploadCallback,
  UPLOAD_CALLBACK_PREFIX,
  type UploadDeps,
} from './lib/upload/handleUpload';
import { reportOutcome } from './lib/outcomes/reportOutcome';
import { createRoutes, createSubResolver } from './lib/routes';
import { getSecretString } from './lib/secrets';
import { createTelegramClient } from './lib/telegram';

const dataApiClient = new RDSDataClient({});
const s3Client = new S3Client({});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} environment variable`);
  return value;
}

// Needs `ReportBatchItemFailures` on the event source mapping. FIFO order must
// hold, so after the first failure every later record in the batch is reported
// as failed too (they are retried in order) rather than processed out of turn;
// records that already succeeded are not run again.
export const handler: SQSHandler = async (event) => {
  const telegram = createTelegramClient(
    await getSecretString(requireEnv('BOT_TOKEN_SECRET_ARN')),
  );
  const dataApiConfig = loadDataApiConfigFromEnv();
  const linking = {
    store: createLinkStore(dataApiClient, dataApiConfig),
    config: loadLinkConfigFromEnv(),
  };
  const upload: UploadDeps = {
    client: dataApiClient,
    config: dataApiConfig,
    s3: s3Client,
    bucket: requireEnv('UPLOADS_BUCKET'),
  };
  const accountDeps = { client: dataApiClient, config: dataApiConfig };
  const onNewAccountCallback: Routes['onCallback'] = (ctx, query, data) =>
    handleNewAccountCallback(ctx, query, data, accountDeps);
  const routes = createRoutes({
    resolveSub: createSubResolver(dataApiClient, dataApiConfig),
    onUnlinked: (ctx) => handleUnlinked(ctx, linking),
    commands: {
      unlink: createUnlinkHandler(dataApiClient, dataApiConfig),
      accounts: createAccountsHandler(accountDeps),
      coverage: createCoverageHandler(accountDeps),
      newaccount: createNewAccountHandler(accountDeps),
      cancel: createCancelHandler(accountDeps),
    },
    onDocument: (ctx, message, document) =>
      handleDocument(ctx, message, document, upload),
    // Free text answers an open dialogue; otherwise it is the help reply.
    onText: async (ctx, text) => {
      if (await handleNewAccountText(ctx, text, accountDeps)) return;
      await ctx.telegram.sendMessage(ctx.chatId, HELP_TEXT);
    },
    callbacks: {
      [UPLOAD_CALLBACK_PREFIX]: (ctx, query, data) =>
        handleUploadCallback(ctx, query, data, upload),
      [COVERAGE_CALLBACK_PREFIX]: (ctx, _query, data) =>
        handleCoverageCallback(ctx, data, accountDeps),
      [BANK_CALLBACK_PREFIX]: onNewAccountCallback,
      [CONFIRM_CALLBACK_PREFIX]: onNewAccountCallback,
    },
  });

  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    if (batchItemFailures.length > 0) {
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }
    try {
      // Two event sources feed this worker: Telegram updates (FIFO) and the
      // pipeline's statement outcomes.
      const body: unknown = JSON.parse(record.body);
      if (isOutcomeMessage(body)) {
        await reportOutcome(body, {
          client: dataApiClient,
          config: dataApiConfig,
          telegram,
        });
      } else {
        await dispatch(body as Update, telegram, routes);
      }
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
