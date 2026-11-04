import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { executeStatement, type DataApiConfig } from '../dataApi';
import {
  isOutcomeMessage,
  type StatementOutcomeMessage,
} from './outcomeMessage';

// Transactional outbox for outcome messages (design.md decision 1). The row is
// written in the same transaction that commits the file's outcome, so a
// committed outcome is never lost to a failed publish; a sweeper republishes
// any row still unpublished after a minute. Delivery is at-least-once.

type Sender = Pick<SQSClient, 'send'>;

// Runs inside the uploader's import transaction. The database function refuses
// a file the caller did not upload, and is idempotent per file.
export async function enqueueOutcome(
  client: RDSDataClient,
  config: DataApiConfig,
  transactionId: string,
  message: StatementOutcomeMessage,
): Promise<void> {
  if (message.fileId === null) {
    throw new Error('An unrecorded outcome has no outbox row');
  }
  await executeStatement(
    client,
    config,
    `SELECT draupnir.enqueue_outcome(:fileId, CAST(:payload AS jsonb))`,
    { fileId: message.fileId, payload: JSON.stringify(message) },
    transactionId,
  );
}

export async function sendOutcome(
  sqs: Sender,
  queueUrl: string,
  message: StatementOutcomeMessage,
): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(message),
    }),
  );
}

// Publishes a just-committed outcome and marks its outbox row published. A
// failure here is not an error for the caller: the row stays unpublished and
// the sweeper delivers it.
export async function publishCommittedOutcome(
  client: RDSDataClient,
  config: DataApiConfig,
  sqs: Sender,
  queueUrl: string,
  message: StatementOutcomeMessage,
): Promise<boolean> {
  if (message.fileId === null) {
    throw new Error('An unrecorded outcome has no outbox row');
  }
  try {
    await sendOutcome(sqs, queueUrl, message);
    await markPublished(client, config, message.fileId);
    return true;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'outcome-publish-failed',
        fileId: message.fileId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return false;
  }
}

async function markPublished(
  client: RDSDataClient,
  config: DataApiConfig,
  fileId: string,
): Promise<void> {
  await executeStatement(
    client,
    config,
    `SELECT draupnir.mark_outcome_published(:fileId)`,
    { fileId },
  );
}

function parsePayload(value: unknown): StatementOutcomeMessage | null {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return isOutcomeMessage(parsed) ? parsed : null;
}

// Republishes outcomes still unpublished a minute after they were committed.
// Returns how many were published. One failing row does not stop the others.
export async function publishDueOutcomes(
  client: RDSDataClient,
  config: DataApiConfig,
  sqs: Sender,
  queueUrl: string,
  limit = 25,
): Promise<number> {
  const { rows } = await executeStatement(
    client,
    config,
    `SELECT file_id, CAST(payload AS text) AS payload
       FROM draupnir.due_outcomes(CAST(:limit AS integer))`,
    { limit },
  );

  let published = 0;
  for (const row of rows as { file_id: string; payload: unknown }[]) {
    const message = parsePayload(row.payload);
    if (!message) {
      console.error(
        JSON.stringify({
          event: 'outcome-payload-invalid',
          fileId: row.file_id,
        }),
      );
      continue;
    }
    if (await publishCommittedOutcome(client, config, sqs, queueUrl, message)) {
      published += 1;
    }
  }
  return published;
}
