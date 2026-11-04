import type { S3Event, SQSHandler } from 'aws-lambda';
import { RDSDataClient } from '@aws-sdk/client-rds-data';
import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
import {
  loadDataApiConfigFromEnv,
  publishCommittedOutcome,
  publishDueOutcomes,
  sendOutcome,
} from 'shared';
import { processStatementFile } from './lib/processStatementFile';

const dataApiClient = new RDSDataClient({});
const s3Client = new S3Client({});
const sqsClient = new SQSClient({});

export const handler: SQSHandler = async (event) => {
  const dataApiConfig = loadDataApiConfigFromEnv();
  // Where each file's outcome goes (any channel can consume it). Unset only
  // before the bot is deployed; outbox rows then wait for the sweeper.
  const outcomeQueueUrl = process.env['OUTCOME_QUEUE_URL'];

  for (const record of event.Records) {
    const s3Event = JSON.parse(record.body) as S3Event;

    // S3 sends a one-time s3:TestEvent (no `Records` field) through the
    // queue when a bucket notification configuration is first created, to
    // confirm the destination is reachable — not a real object upload.
    if (!Array.isArray(s3Event.Records)) {
      continue;
    }

    for (const s3Record of s3Event.Records) {
      const bucket = s3Record.s3.bucket.name;
      const key = decodeURIComponent(
        s3Record.s3.object.key.replace(/\+/g, ' '),
      );

      // A validation rejection is a recorded outcome, not a failure: only an
      // unexpected error throws and takes the retry -> DLQ path.
      const outcome = await processStatementFile(
        dataApiClient,
        dataApiConfig,
        s3Client,
        bucket,
        key,
        s3Record.s3.object.size,
      );
      console.log(
        JSON.stringify({
          event: 'statement-processed',
          key,
          fileId: outcome.fileId,
          status: outcome.status,
          redelivered: outcome.redelivered,
          reasons: outcome.reasons.length,
        }),
      );

      if (outcomeQueueUrl && outcome.report) {
        if (outcome.report.fileId === null) {
          // Unrecorded, so no outbox row: a failure throws and the upload
          // message is retried to the same deterministic rejection.
          await sendOutcome(sqsClient, outcomeQueueUrl, outcome.report);
        } else {
          // Committed with its outbox row: if this publish fails, the sweeper
          // delivers it, so a failure is logged rather than retried.
          await publishCommittedOutcome(
            dataApiClient,
            dataApiConfig,
            sqsClient,
            outcomeQueueUrl,
            outcome.report,
          );
        }
      }
    }
  }

  // Also pick up any earlier outcome whose publish was missed.
  if (outcomeQueueUrl) {
    await publishDueOutcomes(
      dataApiClient,
      dataApiConfig,
      sqsClient,
      outcomeQueueUrl,
    ).catch((error: unknown) =>
      console.error(
        JSON.stringify({
          event: 'outcome-sweep-failed',
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
  }
};
