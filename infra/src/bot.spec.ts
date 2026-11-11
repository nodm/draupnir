import * as pulumi from '@pulumi/pulumi';

// An offline stand-in for `pulumi preview`: the program runs against recorded
// mocks, so wiring mistakes (a missing permission, an open route, a queue that
// is too impatient) fail here without AWS credentials.
interface Recorded {
  type: string;
  name: string;
  inputs: Record<string, unknown>;
}
const recorded: Recorded[] = [];

beforeAll(async () => {
  await pulumi.runtime.setMocks(
    {
      newResource: (args) => {
        recorded.push({
          type: args.type,
          name: args.name,
          inputs: args.inputs as Record<string, unknown>,
        });
        return {
          id: `${args.name}-id`,
          state: {
            ...args.inputs,
            arn: `arn:aws:mock:::${args.type}/${args.name}`,
            url: `https://sqs.mock/${args.name}`,
            invokeArn: `arn:invoke:${args.name}`,
            executionArn: `arn:execute:${args.name}`,
            rootResourceId: 'root',
            clientSecret: 'client-secret',
            result: 'webhook-secret-value',
            bucket: `${args.name}-bucket`,
            domain: 'auth-prefix',
          },
        };
      },
      call: (args) => args.inputs,
    },
    'draupnir-infra',
    'prod',
    false,
  );
  pulumi.runtime.setAllConfig({
    'aws:region': 'eu-north-1',
    'draupnir-infra:botUsername': 'draupnir_test_bot',
    'draupnir-infra:allowedTelegramUserIds': '111,222',
  });
});

const named = (type: string, name?: string) =>
  recorded.filter((r) => r.type === type && (!name || r.name === name));
const one = (type: string, name: string) => {
  const found = named(type, name);
  expect(found, `${type} ${name}`).toHaveLength(1);
  return (found[0] as Recorded).inputs;
};
// A Lambda environment holding a Pulumi secret is recorded wrapped as
// { <secret marker>: ..., value }; unwrap it to the plain { variables }.
const envOf = (name: string): Record<string, string> => {
  const raw = one('aws:lambda/function:Function', name)['environment'] as {
    value?: { variables: Record<string, string> };
    variables?: Record<string, string>;
  };
  return (raw.value ?? raw).variables ?? {};
};
const value = async (v: unknown) => pulumi.output(v).promise();
const statements = async (role: string) =>
  (
    JSON.parse(
      (await value(
        one('aws:iam/rolePolicy:RolePolicy', `${role}-policy`)['policy'],
      )) as string,
    ) as { Statement: { Action: string | string[]; Resource: unknown }[] }
  ).Statement;
const allows = (statements: { Action: string | string[] }[], action: string) =>
  statements.some((s) => [s.Action].flat().includes(action));

let outputs: Awaited<ReturnType<typeof build>>;
async function build() {
  const aws = await import('@pulumi/aws');
  const { createBot } = await import('../lib/bot');
  const { createBotQueues } = await import('../lib/botQueues');
  const provider = new aws.Provider('aws', { region: 'eu-north-1' });
  const userPool = new aws.cognito.UserPool('users', {}, { provider });
  const authPool = {
    userPool,
    userPoolClient: new aws.cognito.UserPoolClient(
      'app',
      { userPoolId: userPool.id },
      { provider },
    ),
    domain: new aws.cognito.UserPoolDomain(
      'login',
      { userPoolId: userPool.id, domain: 'auth-prefix' },
      { provider },
    ),
    googleIdentityProvider: new aws.cognito.IdentityProvider(
      'google',
      {
        userPoolId: userPool.id,
        providerName: 'Google',
        providerType: 'Google',
        providerDetails: {},
      },
      { provider },
    ),
  };
  const queues = createBotQueues(provider);
  const bot = createBot(provider, {
    authPool,
    dbConfig: {
      clusterArn: 'arn:cluster',
      secretArn: 'arn:dbsecret',
      name: 'draupnir',
    },
    uploadsBucket: new aws.s3.Bucket('uploads', {}, { provider }),
    queues,
    dependsOn: [],
  });
  return { bot, queues };
}

beforeAll(async () => {
  outputs = await build();
  // Resources register asynchronously; wait until every one has.
  await pulumi.runtime.disconnect();
});

describe('queues', () => {
  it('keeps messages away from a retry for longer than the 2-minute report lease', async () => {
    for (const name of ['bot-updates', 'bot-outcomes']) {
      const seconds = one('aws:sqs/queue:Queue', name)[
        'visibilityTimeoutSeconds'
      ] as number;
      expect(seconds).toBeGreaterThan(120);
    }
  });

  it('orders a chat’s updates in a FIFO queue with explicit deduplication, others in a standard queue', () => {
    const updates = one('aws:sqs/queue:Queue', 'bot-updates');
    expect(updates['fifoQueue']).toBe(true);
    expect(updates['contentBasedDeduplication']).toBe(false);
    expect(
      one('aws:sqs/queue:Queue', 'bot-outcomes')['fifoQueue'],
    ).toBeUndefined();
  });

  it('names FIFO queues with the .fifo suffix AWS requires, and only those', async () => {
    const queues = named('aws:sqs/queue:Queue');
    expect(queues.length).toBeGreaterThan(0);
    for (const q of queues) {
      const name = q.inputs['name'] as string | undefined;
      if (q.inputs['fifoQueue']) {
        expect(name, q.name).toMatch(/\.fifo$/);
      } else {
        expect(name ?? '', q.name).not.toMatch(/\.fifo$/);
      }
    }
  });

  it('moves a message that keeps failing to a dead-letter queue', async () => {
    for (const name of ['bot-updates', 'bot-outcomes']) {
      const policy = JSON.parse(
        (await value(
          one('aws:sqs/queue:Queue', name)['redrivePolicy'],
        )) as string,
      );
      expect(policy.maxReceiveCount).toBeGreaterThan(0);
      expect(policy.deadLetterTargetArn).toContain(`${name}-dlq`);
    }
  });
});

describe('public routes', () => {
  it('serves the webhook and the callback without a Cognito authorizer, nothing else', () => {
    const methods = named('aws:apigateway/method:Method');
    expect(methods.map((m) => m.name).sort()).toEqual([
      'bot-callback',
      'bot-webhook',
    ]);
    for (const m of methods) {
      expect(m.inputs['authorization']).toBe('NONE');
    }
    expect(
      one('aws:apigateway/method:Method', 'bot-webhook')['httpMethod'],
    ).toBe('POST');
    expect(
      one('aws:apigateway/method:Method', 'bot-callback')['httpMethod'],
    ).toBe('GET');
  });

  it('throttles every public route', () => {
    const settings = one(
      'aws:apigateway/methodSettings:MethodSettings',
      'bot-throttle',
    );
    expect(settings['methodPath']).toBe('*/*');
    expect(settings['settings']).toMatchObject({
      throttlingRateLimit: 10,
      throttlingBurstLimit: 20,
    });
  });

  it('publishes URLs ending in /webhook and /telegram/callback', async () => {
    expect(await value(outputs.bot.webhookUrl)).toMatch(/\/webhook$/);
    expect(await value(outputs.bot.callbackUrl)).toMatch(
      /^https:\/\/bot-id\.execute-api\.eu-north-1\.amazonaws\.com\/prod\/telegram\/callback$/,
    );
  });
});

describe('linking client', () => {
  it('is its own confidential client that returns to the callback URL only', async () => {
    const client = one('aws:cognito/userPoolClient:UserPoolClient', 'telegram');
    expect(client['name']).toBe('draupnir-telegram');
    expect(client['generateSecret']).toBe(true);
    expect(client['allowedOauthFlows']).toEqual(['code']);
    expect(client['callbackUrls']).toEqual([
      await value(outputs.bot.callbackUrl),
    ]);
    expect(
      named(
        'aws:cognito/managedLoginBranding:ManagedLoginBranding',
        'telegram',
      ),
    ).toHaveLength(1);
  });

  it('tells the callback and the worker the same client, callback URL and bot name', async () => {
    for (const fn of ['bot-callback', 'bot-worker']) {
      const env = (
        one('aws:lambda/function:Function', fn)['environment'] as {
          variables: Record<string, string>;
        }
      ).variables;
      expect(env['TELEGRAM_CALLBACK_URL']).toMatch(/\/telegram\/callback$/);
      expect(env['TELEGRAM_CLIENT_ID']).toBe('telegram-id');
      expect(env['BOT_USERNAME']).toBe('draupnir_test_bot');
      expect(env['COGNITO_BASE_URL']).toBe(
        'https://auth-prefix.auth.eu-north-1.amazoncognito.com',
      );
    }
  });
});

describe('worker', () => {
  it('consumes both queues one message at a time and reports partial failures', () => {
    const mappings = named('aws:lambda/eventSourceMapping:EventSourceMapping');
    expect(mappings.map((m) => m.name).sort()).toEqual([
      'bot-outcomes',
      'bot-updates',
    ]);
    for (const m of mappings) {
      expect(m.inputs['functionResponseTypes']).toEqual([
        'ReportBatchItemFailures',
      ]);
      expect(m.inputs['batchSize']).toBe(1);
    }
  });

  it('may write uploads, look users up, read its secret and consume the queues, nothing broader', async () => {
    const s = await statements('bot-worker');
    expect(allows(s, 's3:PutObject')).toBe(true);
    expect(allows(s, 'cognito-idp:ListUsers')).toBe(true);
    expect(allows(s, 'sqs:ReceiveMessage')).toBe(true);
    expect(allows(s, 'rds-data:ExecuteStatement')).toBe(true);
    expect(allows(s, 's3:GetObject')).toBe(false);
    expect(allows(s, 'sqs:SendMessage')).toBe(false);
    const put = s.find((x) => [x.Action].flat().includes('s3:PutObject'));
    expect(String(put?.Resource)).toMatch(/\/uploads\/\*$/);
    expect(JSON.stringify(s)).not.toContain('"*"');
  });

  it('waits for the report lease: its timeout times six is the queue visibility timeout', async () => {
    const timeout = one('aws:lambda/function:Function', 'bot-worker')[
      'timeout'
    ] as number;
    expect(
      one('aws:sqs/queue:Queue', 'bot-updates')['visibilityTimeoutSeconds'],
    ).toBe(timeout * 6);
  });
});

describe('webhook', () => {
  it('can only read its own secret and enqueue; it has no database access', async () => {
    const s = await statements('bot-webhook');
    expect(allows(s, 'sqs:SendMessage')).toBe(true);
    expect(allows(s, 'secretsmanager:GetSecretValue')).toBe(true);
    expect(allows(s, 'rds-data:ExecuteStatement')).toBe(false);
    const env = envOf('bot-webhook');
    expect(Object.keys(env).sort()).toEqual([
      'ALLOWED_TELEGRAM_USER_IDS',
      'BOT_UPDATES_QUEUE_URL',
      'WEBHOOK_SECRET_ARN',
    ]);
    expect(env['ALLOWED_TELEGRAM_USER_IDS']).toBe('111,222');
  });

  it('is the only function that gets the sender allowlist', () => {
    const holders = named('aws:lambda/function:Function')
      .map((f) => f.name)
      .filter((n) => 'ALLOWED_TELEGRAM_USER_IDS' in envOf(n));
    expect(holders).toEqual(['bot-webhook']);
  });
});

describe('retention', () => {
  it('runs every hour and a failed run is not retried', async () => {
    const schedule = one('aws:scheduler/schedule:Schedule', 'bot-retention');
    expect(schedule['scheduleExpression']).toBe('rate(1 hour)');
    expect(schedule['flexibleTimeWindow']).toEqual({ mode: 'OFF' });
    expect(
      (schedule['target'] as { retryPolicy: unknown }).retryPolicy,
    ).toEqual({ maximumRetryAttempts: 0 });
  });

  it('may publish outcomes and delete through Telegram, but not touch S3 or Cognito', async () => {
    const s = await statements('bot-retention');
    expect(allows(s, 'sqs:SendMessage')).toBe(true);
    expect(allows(s, 's3:PutObject')).toBe(false);
    expect(allows(s, 'cognito-idp:ListUsers')).toBe(false);
    const env = (
      one('aws:lambda/function:Function', 'bot-retention')['environment'] as {
        variables: Record<string, string>;
      }
    ).variables;
    expect(env['OUTCOME_QUEUE_URL']).toBeDefined();
  });

  it('is invoked by a role that may call only that function', async () => {
    const s = await statements('bot-retention-schedule').catch(() => []);
    void s;
    const policy = JSON.parse(
      (await value(
        one('aws:iam/rolePolicy:RolePolicy', 'bot-retention-schedule')[
          'policy'
        ],
      )) as string,
    );
    expect(policy.Statement).toHaveLength(1);
    expect(policy.Statement[0].Action).toBe('lambda:InvokeFunction');
  });
});

describe('secrets', () => {
  it('creates the bot token secret empty: the value is never in Pulumi', () => {
    expect(named('aws:secretsmanager/secret:Secret', 'bot-token')).toHaveLength(
      1,
    );
    expect(
      named('aws:secretsmanager/secretVersion:SecretVersion').map(
        (v) => v.name,
      ),
    ).not.toContain('bot-token');
  });

  it('stores the webhook secret and the client secret', () => {
    expect(
      named('aws:secretsmanager/secretVersion:SecretVersion')
        .map((v) => v.name)
        .sort(),
    ).toEqual(['bot-telegram-client-secret', 'bot-webhook-secret']);
  });
});
