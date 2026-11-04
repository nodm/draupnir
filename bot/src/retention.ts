import { RDSDataClient } from '@aws-sdk/client-rds-data';
import { SQSClient } from '@aws-sdk/client-sqs';
import { loadDataApiConfigFromEnv, publishDueOutcomes } from 'shared';
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

// Runs on a schedule (every 30 minutes). Deletes recorded messages older than
// 24 hours, and re-publishes statement outcomes whose publish was missed (the
// outbox sweeper shares this schedule).
export const handler = async (): Promise<void> => {
  const config = loadDataApiConfigFromEnv();
  const telegram = createTelegramClient(
    await getSecretString(requireEnv('BOT_TOKEN_SECRET_ARN')),
  );

  const outcomeQueueUrl = process.env['OUTCOME_QUEUE_URL'];
  const sweepOutcomes = outcomeQueueUrl
    ? publishDueOutcomes(
        dataApiClient,
        config,
        sqsClient,
        outcomeQueueUrl,
      ).catch((error: unknown) =>
        console.error(
          JSON.stringify({
            event: 'outcome-sweep-failed',
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      )
    : Promise.resolve();

  const result = await sweepRetention(telegram, dataApiClient, config);
  await sweepOutcomes;
  console.log(JSON.stringify({ event: 'retention-swept', ...result }));
};
