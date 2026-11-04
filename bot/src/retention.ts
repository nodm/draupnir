import { RDSDataClient } from '@aws-sdk/client-rds-data';
import { SQSClient } from '@aws-sdk/client-sqs';
import {
  loadDataApiConfigFromEnv,
  publishDueOutcomes,
  republishUnreportedOutcomes,
} from 'shared';
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

// Outcomes that never reached the queue, then outcomes the queue gave up on.
// Each is logged on failure and never stops the retention sweep.
async function republishOutcomes(
  config: ReturnType<typeof loadDataApiConfigFromEnv>,
  queueUrl: string,
): Promise<void> {
  for (const [event, sweep] of [
    ['outcome-sweep-failed', publishDueOutcomes],
    ['outcome-reconcile-failed', republishUnreportedOutcomes],
  ] as const) {
    await sweep(dataApiClient, config, sqsClient, queueUrl).catch(
      (error: unknown) =>
        console.error(
          JSON.stringify({
            event,
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
    );
  }
}

// Runs on a schedule (every 30 minutes). Deletes recorded messages older than
// 24 hours, and re-publishes statement outcomes that were never published or
// never reported (the outbox sweeper shares this schedule).
export const handler = async (): Promise<void> => {
  const config = loadDataApiConfigFromEnv();
  const telegram = createTelegramClient(
    await getSecretString(requireEnv('BOT_TOKEN_SECRET_ARN')),
  );

  const outcomeQueueUrl = process.env['OUTCOME_QUEUE_URL'];
  const sweepOutcomes = outcomeQueueUrl
    ? republishOutcomes(config, outcomeQueueUrl)
    : Promise.resolve();

  const result = await sweepRetention(telegram, dataApiClient, config);
  await sweepOutcomes;
  console.log(JSON.stringify({ event: 'retention-swept', ...result }));
};
