import type { S3Event, SQSHandler } from 'aws-lambda';
import { RDSDataClient } from '@aws-sdk/client-rds-data';
import { S3Client } from '@aws-sdk/client-s3';
import { loadDataApiConfigFromEnv } from './lib/dataApi';
import { parseStatement as parseMonobank } from './lib/parsers/monobank';
import { parseStatement as parseRevolut } from './lib/parsers/revolut';
import { parseStatement as parseSeb } from './lib/parsers/seb';
import {
  processStatementFile,
  type ParserDispatch,
} from './lib/processStatementFile';

const dataApiClient = new RDSDataClient({});
const s3Client = new S3Client({});

const parsers: ParserDispatch = {
  seb: parseSeb,
  revolut: parseRevolut,
  monobank: parseMonobank,
};

export const handler: SQSHandler = async (event) => {
  const dataApiConfig = loadDataApiConfigFromEnv();

  for (const record of event.Records) {
    const s3Event = JSON.parse(record.body) as S3Event;

    for (const s3Record of s3Event.Records) {
      const bucket = s3Record.s3.bucket.name;
      const key = decodeURIComponent(
        s3Record.s3.object.key.replace(/\+/g, ' '),
      );

      await processStatementFile(
        dataApiClient,
        dataApiConfig,
        s3Client,
        parsers,
        bucket,
        key,
      );
    }
  }
};
