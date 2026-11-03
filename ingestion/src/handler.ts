import type { S3Event, SQSHandler } from 'aws-lambda';
import { RDSDataClient } from '@aws-sdk/client-rds-data';
import { S3Client } from '@aws-sdk/client-s3';
import { loadDataApiConfigFromEnv } from 'shared';
import { processStatementFile } from './lib/processStatementFile';

const dataApiClient = new RDSDataClient({});
const s3Client = new S3Client({});

export const handler: SQSHandler = async (event) => {
  const dataApiConfig = loadDataApiConfigFromEnv();

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
    }
  }
};
