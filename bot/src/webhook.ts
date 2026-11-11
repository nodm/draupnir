import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getSecretString } from './lib/secrets';
import { handleWebhook, parseAllowedUserIds } from './lib/webhook';

const sqs = new SQSClient({});

// Parsed once per cold start; a malformed list fails initialisation.
const allowedUserIds = parseAllowedUserIds(
  process.env['ALLOWED_TELEGRAM_USER_IDS'],
);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} environment variable`);
  return value;
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const secret = await getSecretString(requireEnv('WEBHOOK_SECRET_ARN'));
  const queueUrl = requireEnv('BOT_UPDATES_QUEUE_URL');

  return handleWebhook(event, {
    secret,
    allowedUserIds,
    enqueue: async ({ groupId, dedupId, body }) => {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: body,
          MessageGroupId: groupId,
          MessageDeduplicationId: dedupId,
        }),
      );
    },
  });
};
