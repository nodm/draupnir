import { RDSDataClient } from '@aws-sdk/client-rds-data';
import { SQSClient } from '@aws-sdk/client-sqs';
import { loadDataApiConfigFromEnv } from 'shared';
import { sweepOutcomes } from './lib/outcomes/sweepOutcomes';
import { sweepRetention } from './lib/retention/retention';
import { getSecretString } from './lib/secrets';
import { createTelegramClient } from './lib/telegram';

const dataApiClient = new RDSDataClient({});
const sqsClient = new SQSClient({});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} environment variable`);
  return value;
}

// Runs on a schedule (every 12 hours by default, infra/lib/retentionSchedule.ts).
// Deletes recorded messages older than 20 hours, and re-publishes statement
// outcomes that were never published or never reported (the outbox sweeper
// shares this schedule; the worker also runs it when the bot gets traffic).
export const handler = async (): Promise<void> => {
  const config = loadDataApiConfigFromEnv();
  const telegram = createTelegramClient(
    await getSecretString(requireEnv('BOT_TOKEN_SECRET_ARN')),
  );

  const outcomeQueueUrl = process.env['OUTCOME_QUEUE_URL'];
  const outcomesSwept = outcomeQueueUrl
    ? sweepOutcomes(dataApiClient, config, sqsClient, outcomeQueueUrl)
    : Promise.resolve();

  const result = await sweepRetention(telegram, dataApiClient, config);
  await outcomesSwept;
  console.log(JSON.stringify({ event: 'retention-swept', ...result }));
};
