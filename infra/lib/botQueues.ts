import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';

// The worker Lambda's timeout. Both queues below hold messages for six times
// that after a failure (AWS's guidance for SQS-triggered functions), which is
// also longer than the 2-minute outcome-report lease (design decision 7): a
// redelivery can never overlap a live claim.
export const BOT_WORKER_TIMEOUT_SECONDS = 90;
const VISIBILITY_TIMEOUT_SECONDS = BOT_WORKER_TIMEOUT_SECONDS * 6;
const DLQ_RETENTION_SECONDS = 14 * 24 * 60 * 60;

// A chat's updates must be handled in order, so a failing update holds up only
// its own chat until it has been tried this often and moved to the DLQ.
const UPDATES_MAX_RECEIVE_COUNT = 3;
const OUTCOMES_MAX_RECEIVE_COUNT = 5;

export interface BotQueues {
  // Telegram updates; FIFO, group = chat id, dedup = update_id.
  updates: aws.sqs.Queue;
  updatesDlq: aws.sqs.Queue;
  // Statement outcomes published by ingestion; standard queue.
  outcomes: aws.sqs.Queue;
  outcomesDlq: aws.sqs.Queue;
}

export function createBotQueues(provider: aws.Provider): BotQueues {
  const withProvider = { provider };

  const updatesDlq = new aws.sqs.Queue(
    'bot-updates-dlq',
    {
      fifoQueue: true,
      messageRetentionSeconds: DLQ_RETENTION_SECONDS,
    },
    withProvider,
  );
  const updates = new aws.sqs.Queue(
    'bot-updates',
    {
      fifoQueue: true,
      // The webhook sends an explicit deduplication id (the update_id).
      contentBasedDeduplication: false,
      visibilityTimeoutSeconds: VISIBILITY_TIMEOUT_SECONDS,
      redrivePolicy: pulumi.jsonStringify({
        deadLetterTargetArn: updatesDlq.arn,
        maxReceiveCount: UPDATES_MAX_RECEIVE_COUNT,
      }),
    },
    withProvider,
  );

  const outcomesDlq = new aws.sqs.Queue(
    'bot-outcomes-dlq',
    { messageRetentionSeconds: DLQ_RETENTION_SECONDS },
    withProvider,
  );
  const outcomes = new aws.sqs.Queue(
    'bot-outcomes',
    {
      visibilityTimeoutSeconds: VISIBILITY_TIMEOUT_SECONDS,
      redrivePolicy: pulumi.jsonStringify({
        deadLetterTargetArn: outcomesDlq.arn,
        maxReceiveCount: OUTCOMES_MAX_RECEIVE_COUNT,
      }),
    },
    withProvider,
  );

  return { updates, updatesDlq, outcomes, outcomesDlq };
}
