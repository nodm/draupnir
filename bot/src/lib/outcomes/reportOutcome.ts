import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import {
  executeStatement,
  withCaller,
  type DataApiConfig,
  type StatementOutcomeMessage,
} from 'shared';
import type { Retention } from '../retention/retention';
import type { TelegramClient } from '../telegram';
import { formatOutcomeReport } from './formatReport';

export interface ReportDeps {
  client: RDSDataClient;
  config: DataApiConfig;
  telegram: TelegramClient;
  retention: Retention;
}

// Delivery is at-least-once and two workers can hold the same outcome at once,
// so "was it reported?" is not enough. The report is claimed atomically with a
// lease (`claim_outcome_report`): exactly one caller gets the chat to write to,
// the rest drop the message. If the claimant dies before sending, the claim
// lapses after the lease and the queue's redelivery (visibility timeout longer
// than the lease) claims it again. A crash between sending and marking can
// still produce one duplicate report, which is accepted: a lost report is worse.
export async function reportOutcome(
  message: StatementOutcomeMessage,
  { client, config, telegram, retention }: ReportDeps,
): Promise<'reported' | 'skipped'> {
  const { rows } = await executeStatement(
    client,
    config,
    `SELECT chat_id FROM draupnir.claim_outcome_report(:s3Key)`,
    { s3Key: message.s3Key },
  );
  const claim = rows[0] as { chat_id: number } | undefined;
  // Not claimable: already reported, someone else holds it, or the file did not
  // come through the bot at all.
  if (!claim) return 'skipped';

  await telegram.sendMessage(claim.chat_id, formatOutcomeReport(message));

  await executeStatement(
    client,
    config,
    `SELECT draupnir.mark_outcome_reported(:s3Key)`,
    { s3Key: message.s3Key },
  );

  // The statement itself leaves the chat once its outcome has been reported.
  // Best effort: if this fails (or we crash here) the file was recorded when
  // it arrived, so the scheduled run removes it 20-32 hours after it was sent.
  await discardUploadedFile(message, claim.chat_id, {
    client,
    config,
    telegram,
    retention,
  });
  return 'reported';
}

async function discardUploadedFile(
  message: StatementOutcomeMessage,
  chatId: number,
  { client, config, telegram, retention }: ReportDeps,
): Promise<void> {
  try {
    // As the uploader: their pending-upload row is theirs under RLS.
    const rows = await withCaller(
      client,
      config,
      message.sub,
      async (tx) =>
        (
          await executeStatement(
            client,
            config,
            `SELECT message_id FROM bot_pending_uploads WHERE s3_key = :s3Key AND chat_id = CAST(:chatId AS bigint)`,
            { s3Key: message.s3Key, chatId },
            tx,
          )
        ).rows,
    );
    const messageId = (rows[0] as { message_id: number | string } | undefined)
      ?.message_id;
    if (messageId !== undefined) {
      await retention.discard(telegram, chatId, Number(messageId));
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'retention-upload-lookup-failed',
        s3Key: message.s3Key,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
