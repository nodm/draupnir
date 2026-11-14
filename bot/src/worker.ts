import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { RDSDataClient } from '@aws-sdk/client-rds-data';
import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
import type { SQSHandler } from 'aws-lambda';
import type { Update } from '@grammyjs/types';
import { isOutcomeMessage, loadDataApiConfigFromEnv } from 'shared';
import { createCognitoDirectory, type UserDirectory } from './lib/directory';
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
import {
  createShareHandler,
  createUnshareHandler,
  handleSharingCallback,
  handleSharingText,
  SHARE_ACCOUNT_PREFIX,
  SHARE_ROLE_PREFIX,
  UNSHARE_ACCOUNT_PREFIX,
  UNSHARE_MEMBER_PREFIX,
} from './lib/commands/share';
import {
  createRenameHandler,
  handleRenameCallback,
  handleRenameText,
  RENAME_ACCOUNT_PREFIX,
} from './lib/commands/renameAccount';
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
import { sweepOutcomes } from './lib/outcomes/sweepOutcomes';
import { createRoutes, createSubResolver } from './lib/routes';
import { getSecretString } from './lib/secrets';
import { createRetention, withRetention } from './lib/retention/retention';
import { createTelegramClient } from './lib/telegram';

const dataApiClient = new RDSDataClient({});
const s3Client = new S3Client({});
const cognitoClient = new CognitoIdentityProviderClient({});
const sqsClient = new SQSClient({});

// After handling user traffic, while Aurora is awake anyway, the worker also
// retries missed outcomes (design.md decision 6), at most this often per warm
// container so a busy chat does not add the sweep to every update.
export const OUTCOME_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
let lastOutcomeSweepAt = -Infinity;

// Built on first use, so updates that never touch /share or /unshare do not
// depend on USER_POOL_ID (or the Cognito permission) being configured.
function lazyDirectory(make: () => UserDirectory): UserDirectory {
  let directory: UserDirectory | undefined;
  const get = () => (directory ??= make());
  return {
    findByEmail: (email) => get().findByEmail(email),
    emailOf: (sub) => get().emailOf(sub),
  };
}

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
  const dataApiConfig = loadDataApiConfigFromEnv();
  const retention = createRetention(dataApiClient, dataApiConfig);
  // Everything the bot says is recorded for deletion (retention).
  const telegram = withRetention(
    createTelegramClient(
      await getSecretString(requireEnv('BOT_TOKEN_SECRET_ARN')),
    ),
    retention,
  );
  const linking = {
    store: createLinkStore(dataApiClient, dataApiConfig),
    config: loadLinkConfigFromEnv(),
    stateSecret: await getSecretString(requireEnv('LINK_STATE_SECRET_ARN')),
  };
  const upload: UploadDeps = {
    client: dataApiClient,
    config: dataApiConfig,
    s3: s3Client,
    bucket: requireEnv('UPLOADS_BUCKET'),
    retention,
  };
  const accountDeps = { client: dataApiClient, config: dataApiConfig };
  const sharing = {
    ...accountDeps,
    directory: lazyDirectory(() =>
      createCognitoDirectory(cognitoClient, requireEnv('USER_POOL_ID')),
    ),
  };
  const onSharingCallback: Routes['onCallback'] = (ctx, query, data) =>
    handleSharingCallback(ctx, query, data, sharing);
  const onRenameCallback: Routes['onCallback'] = (ctx, query, data) =>
    handleRenameCallback(ctx, query, data, sharing);
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
      share: createShareHandler(sharing),
      unshare: createUnshareHandler(sharing),
      renameaccount: createRenameHandler(sharing),
    },
    onDocument: (ctx, message, document) =>
      handleDocument(ctx, message, document, upload),
    // Free text answers an open dialogue; otherwise it is the help reply.
    onText: async (ctx, text) => {
      if (await handleNewAccountText(ctx, text, accountDeps)) return;
      if (await handleSharingText(ctx, text, sharing)) return;
      if (await handleRenameText(ctx, text, sharing)) return;
      await ctx.telegram.sendMessage(ctx.chatId, HELP_TEXT);
    },
    callbacks: {
      [UPLOAD_CALLBACK_PREFIX]: (ctx, query, data) =>
        handleUploadCallback(ctx, query, data, upload),
      [COVERAGE_CALLBACK_PREFIX]: (ctx, query, data) =>
        handleCoverageCallback(ctx, query, data, accountDeps),
      [BANK_CALLBACK_PREFIX]: onNewAccountCallback,
      [CONFIRM_CALLBACK_PREFIX]: onNewAccountCallback,
      [SHARE_ACCOUNT_PREFIX]: onSharingCallback,
      [SHARE_ROLE_PREFIX]: onSharingCallback,
      [UNSHARE_ACCOUNT_PREFIX]: onSharingCallback,
      [UNSHARE_MEMBER_PREFIX]: onSharingCallback,
      [RENAME_ACCOUNT_PREFIX]: onRenameCallback,
    },
  });

  const batchItemFailures: { itemIdentifier: string }[] = [];
  let handledUpdate = false;
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
          retention,
        });
      } else {
        await dispatch(body as Update, telegram, routes);
        handledUpdate = true;
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

  // Only after a fully handled batch of updates: not after outcomes (no
  // republishing as a side effect of reporting), not when the chat is failing.
  // A failing sweep is logged; the batch result stays as it is.
  const outcomeQueueUrl = process.env['OUTCOME_QUEUE_URL'];
  if (
    outcomeQueueUrl &&
    handledUpdate &&
    batchItemFailures.length === 0 &&
    Date.now() - lastOutcomeSweepAt >= OUTCOME_SWEEP_INTERVAL_MS
  ) {
    lastOutcomeSweepAt = Date.now();
    try {
      await sweepOutcomes(
        dataApiClient,
        dataApiConfig,
        sqsClient,
        outcomeQueueUrl,
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'outcome-sweep-failed',
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  return { batchItemFailures };
};
