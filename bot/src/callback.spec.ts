// @vitest-environment node
import type { APIGatewayProxyEvent } from 'aws-lambda';

const getSecretString = vi.fn(async (arn: string) => `secret-of-${arn}`);
const consumeState = vi.fn();

vi.mock('./lib/secrets', () => ({ getSecretString }));
vi.mock('./lib/telegram', () => ({ createTelegramClient: () => ({}) }));
vi.mock('./lib/linking/linkStore', () => ({
  createLinkStore: () => ({ consumeState }),
}));
vi.mock('@aws-sdk/client-rds-data', () => ({ RDSDataClient: class {} }));
vi.mock('shared', () => ({ loadDataApiConfigFromEnv: () => ({}) }));

const event = (state: string) =>
  ({
    queryStringParameters: { code: 'c', state },
  }) as unknown as APIGatewayProxyEvent;

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(process.env, {
    COGNITO_BASE_URL: 'https://auth.example.com',
    TELEGRAM_CLIENT_ID: 'client',
    TELEGRAM_CALLBACK_URL: 'https://api.example.com/cb',
    BOT_USERNAME: 'Bot',
    USER_POOL_ID: 'eu-north-1_abc123',
    BOT_TOKEN_SECRET_ARN: 'arn:token',
    TELEGRAM_CLIENT_SECRET_ARN: 'arn:client',
    LINK_STATE_SECRET_ARN: 'arn:state',
  });
});

describe('callback handler', () => {
  it('a forged state reads only the link-state secret and never the database', async () => {
    const { handler } = await import('./callback');

    const result = await handler(event('forged'));

    expect(result.statusCode).toBe(400);
    expect(getSecretString.mock.calls.map(([arn]) => arn)).toEqual([
      'arn:state',
    ]);
    expect(consumeState).not.toHaveBeenCalled();
  });
});
