import { RDSDataClient } from '@aws-sdk/client-rds-data';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { loadDataApiConfigFromEnv } from 'shared';
import { handleLinkCallback } from './lib/linking/callback';
import { loadLinkConfigFromEnv } from './lib/linking/config';
import { createIdTokenVerifier } from './lib/linking/idToken';
import { createLinkStore } from './lib/linking/linkStore';
import { exchangeAuthorizationCode } from './lib/linking/tokenEndpoint';
import { getSecretString } from './lib/secrets';
import { createTelegramClient } from './lib/telegram';

const dataApiClient = new RDSDataClient({});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} environment variable`);
  return value;
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const config = loadLinkConfigFromEnv();
  const telegram = createTelegramClient(
    await getSecretString(requireEnv('BOT_TOKEN_SECRET_ARN')),
  );
  const clientSecret = await getSecretString(
    requireEnv('TELEGRAM_CLIENT_SECRET_ARN'),
  );

  const result = await handleLinkCallback(
    {
      code: event.queryStringParameters?.['code'],
      state: event.queryStringParameters?.['state'],
      error: event.queryStringParameters?.['error'],
    },
    {
      store: createLinkStore(dataApiClient, loadDataApiConfigFromEnv()),
      config,
      exchangeCode: (input) =>
        exchangeAuthorizationCode(config, clientSecret, input),
      verifyIdToken: createIdTokenVerifier({
        userPoolId: requireEnv('USER_POOL_ID'),
        clientId: config.clientId,
      }),
      notify: async (chatId, text) => {
        await telegram.sendMessage(chatId, text);
      },
    },
  );

  return {
    statusCode: result.statusCode,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    },
    body: result.html,
  };
};
