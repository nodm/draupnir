import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import {
  executeStatement,
  type DataApiConfig,
  type StatementOutcomeMessage,
} from 'shared';
import type { TelegramClient } from '../telegram';
import { formatOutcomeReport } from './formatReport';

export interface ReportDeps {
  client: RDSDataClient;
  config: DataApiConfig;
  telegram: TelegramClient;
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
  { client, config, telegram }: ReportDeps,
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
  return 'reported';
}
