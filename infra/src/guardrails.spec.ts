import * as pulumi from '@pulumi/pulumi';

// The whole program against recorded mocks, as in bot.spec.ts. Pins the cost
// and capacity guardrails:
// - account concurrency (cost-guardrails spec): the three SQS mappings are
//   capped, and no function uses reserved concurrency (the account quota of 10
//   equals AWS's unreserved floor, so none could be set);
// - API throttles (mcp-server-api, mcp-oauth-discovery, user-authentication):
//   every REST API stage has a `*/*` default, the MCP token and register
//   overrides stay, and the MCP API is served only on its custom domain;
// - log retention (cost-guardrails spec): every function writes to its own
//   stack-owned log group with the configured retention (default 30 days);
// - upload retention (statement-raw-storage, statement-ingestion-pipeline):
//   uploads expire after 30 days, abandoned multipart uploads after 1 day,
//   and the ingestion DLQ keeps messages for 14 days;
// - alerts (cost-guardrails, statement-ingestion-pipeline): an account-wide
//   monthly budget, a cost anomaly subscription, alarms on every DLQ and on
//   the ingestion backlog, and 14-day retention on the ingestion queue.

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  // databaseMigrations hashes the built migration bundle, which tests don't build.
  return { ...actual, readFileSync: () => Buffer.from('bundle') };
});

interface Recorded {
  type: string;
  name: string;
  inputs: Record<string, unknown>;
}
const recorded: Recorded[] = [];
const named = (type: string) => recorded.filter((r) => r.type === type);

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
            // Stands in for Pulumi's autonaming, which mocks skip: an alarm's
            // QueueName dimension reads the queue's physical name.
            name: `${args.name}-physical`,
            ...args.inputs,
            arn: `arn:aws:mock:::${args.type}/${args.name}`,
            url: `https://sqs.mock/${args.name}`,
            invokeArn: `arn:invoke:${args.name}`,
            executionArn: `arn:execute:${args.name}`,
            rootResourceId: 'root',
            clientSecret: 'client-secret',
            result: 'secret-value',
            bucket: `${args.name}-bucket`,
            domain: 'auth-prefix',
            versionId: 'v1',
            masterUserSecrets: [{ secretArn: 'arn:master-secret' }],
            engine: 'aurora-postgresql',
            engineVersion: '16.4',
          },
        };
      },
      // Data sources: aurora.ts reads the availability zone names and
      // mcpApi.ts the hosted zone id.
      call: (args) => ({
        ...args.inputs,
        names: ['eu-north-1a', 'eu-north-1b', 'eu-north-1c'],
        zoneId: 'zone-id',
      }),
    },
    'draupnir-infra',
    'prod',
    false,
  );
  pulumi.runtime.setAllConfig({
    'aws:region': 'eu-north-1',
    'draupnir-infra:botUsername': 'draupnir_test_bot',
    'draupnir-infra:allowedTelegramUserIds': '111,222',
    'draupnir-infra:allowlistedEmails': 'a@example.com',
    'draupnir-infra:alertEmail': 'alerts@example.com',
    'draupnir-infra:authDomainPrefix': 'auth-prefix',
    'draupnir-infra:mcpHost': 'mcp.example.com',
    'draupnir-infra:mcpHostedZone': 'example.com',
    'google:clientId': 'client-id',
    'google:clientSecret': 'client-secret',
  });

  const { createAlerts } = await import('../lib/alerts');
  const { createAuroraCluster } = await import('../lib/aurora');
  const { createBot } = await import('../lib/bot');
  const { createBotQueues } = await import('../lib/botQueues');
  const { createAuthPool } = await import('../lib/cognito');
  const { createDatabaseMigrations } = await import(
    '../lib/databaseMigrations'
  );
  const { createIngestionApi } = await import('../lib/ingestionApi');
  const { createIngestionPipeline } = await import('../lib/ingestionPipeline');
  const { createMcpApi } = await import('../lib/mcpApi');
  const { createAwsProvider } = await import('../lib/provider');

  // Mirrors infra/index.ts.
  const provider = createAwsProvider();
  const authPool = createAuthPool(provider);
  const aurora = createAuroraCluster(provider);
  const migrations = createDatabaseMigrations(
    provider,
    aurora.dbConfig,
    aurora.instance,
    aurora.appSecretVersion,
  );
  const afterMigrations = [migrations.invocation];
  const queues = createBotQueues(provider);
  const pipeline = createIngestionPipeline(
    provider,
    aurora.appDbConfig,
    afterMigrations,
    queues.outcomes,
  );
  createIngestionApi(
    authPool.userPool,
    provider,
    aurora.appDbConfig,
    pipeline.uploadsBucket,
    afterMigrations,
  );
  createMcpApi(authPool, provider, aurora.appDbConfig, afterMigrations);
  createBot(provider, {
    authPool,
    dbConfig: aurora.appDbConfig,
    uploadsBucket: pipeline.uploadsBucket,
    queues,
    dependsOn: afterMigrations,
  });
  createAlerts(provider, {
    ingestion: pipeline.queue,
    ingestionDlq: pipeline.deadLetterQueue,
    botUpdatesDlq: queues.updatesDlq,
    botOutcomesDlq: queues.outcomesDlq,
  });
  // Resources register asynchronously; wait until every one has.
  await pulumi.runtime.disconnect();
  // Building the whole program takes ~6s alone; well past vitest's 10s hook
  // default when other projects' tests share a small machine's CPUs.
}, 60_000);

describe('account concurrency guardrails', () => {
  it('caps every SQS mapping at two concurrent invocations', () => {
    const mappings = named('aws:lambda/eventSourceMapping:EventSourceMapping');
    expect(mappings.map((m) => m.name).sort()).toEqual([
      'bot-outcomes',
      'bot-updates',
      'ingest',
    ]);
    for (const m of mappings) {
      expect(m.inputs['scalingConfig'], m.name).toEqual({
        maximumConcurrency: 2,
      });
    }
  });

  it('uses no reserved concurrency on any function while the account quota is at AWS’s floor', () => {
    const functions = named('aws:lambda/function:Function');
    // Every function in the program, including the uncapped ones.
    expect(functions.map((f) => f.name)).toEqual(
      expect.arrayContaining([
        'pre-sign-up-trigger',
        'migrate-database',
        'rebuild-account',
        'bot-retention',
        'bot-worker',
        'ingest',
        'mcp',
        'mcp-oauth',
      ]),
    );
    for (const f of functions) {
      expect(f.inputs['reservedConcurrentExecutions'], f.name).toBeUndefined();
    }
  });
});

describe('API guardrails', () => {
  // The mock gives each resource the id `<name>-id`, so a MethodSettings'
  // restApi input names the RestApi it belongs to.
  const throttlesOf = (restApiName: string) =>
    Object.fromEntries(
      named('aws:apigateway/methodSettings:MethodSettings')
        .filter((m) => m.inputs['restApi'] === `${restApiName}-id`)
        .map((m) => {
          const settings = m.inputs['settings'] as Record<string, unknown>;
          return [
            m.inputs['methodPath'],
            {
              rate: settings['throttlingRateLimit'],
              burst: settings['throttlingBurstLimit'],
            },
          ];
        }),
    );

  it('throttles the MCP stage by default and keeps the stricter token and register limits', () => {
    expect(throttlesOf('mcp')).toEqual({
      '*/*': { rate: 10, burst: 20 },
      'token/POST': { rate: 5, burst: 10 },
      'register/POST': { rate: 1, burst: 5 },
    });
  });

  it('throttles the ingestion stage for two users', () => {
    expect(throttlesOf('ingestion')).toEqual({
      '*/*': { rate: 5, burst: 10 },
    });
  });

  it('keeps the bot stage throttle', () => {
    expect(throttlesOf('bot')).toEqual({ '*/*': { rate: 10, burst: 20 } });
  });

  it('gives every REST API a stage-wide default', () => {
    const apis = named('aws:apigateway/restApi:RestApi');
    expect(apis.map((a) => a.name).sort()).toEqual(['bot', 'ingestion', 'mcp']);
    for (const api of apis) {
      expect(throttlesOf(api.name)['*/*'], api.name).toBeDefined();
    }
  });

  it('serves the MCP API only on its custom domain and redeploys when that changes', () => {
    const [mcp] = named('aws:apigateway/restApi:RestApi').filter(
      (a) => a.name === 'mcp',
    );
    expect(mcp?.inputs['disableExecuteApiEndpoint']).toBe(true);

    const [deployment] = named('aws:apigateway/deployment:Deployment').filter(
      (d) => d.name === 'mcp',
    );
    const triggers = deployment?.inputs['triggers'] as Record<string, string>;
    const hashed = JSON.parse(triggers['redeployment'] as string) as unknown[];
    expect(hashed.at(-1)).toBe(true);
  });
});

describe('log retention guardrails', () => {
  const functions = () => named('aws:lambda/function:Function');
  const logGroups = () => named('aws:cloudwatch/logGroup:LogGroup');

  it('knows every function in the program', () => {
    expect(
      functions()
        .map((f) => f.name)
        .sort(),
    ).toEqual(
      [
        'accounts',
        'bot-callback',
        'bot-retention',
        'bot-webhook',
        'bot-worker',
        'ingest',
        'mcp',
        'mcp-oauth',
        'migrate-database',
        'pre-sign-up-trigger',
        'presigned-upload',
        'rebuild-account',
        'whoami',
      ].sort(),
    );
  });

  // Any function, however it is constructed, must point at a managed group:
  // otherwise Lambda creates /aws/lambda/<name> with retention "Never expire".
  it('sends every function’s logs to its own group with 30-day retention', () => {
    for (const f of functions()) {
      const expected = `/aws/lambda/draupnir/prod/${f.name}`;
      expect(f.inputs['loggingConfig'], f.name).toEqual({
        logFormat: 'Text',
        logGroup: expected,
      });
      const group = logGroups().find((g) => g.inputs['name'] === expected);
      expect(group, expected).toBeDefined();
      expect(group?.inputs['retentionInDays'], expected).toBe(30);
    }
  });

  it('creates no log group that is not a function’s', () => {
    expect(logGroups()).toHaveLength(functions().length);
  });
});

describe('upload retention guardrails', () => {
  type Rule = Record<string, unknown>;
  const lifecycleRules = (): Rule[] => {
    const configs = named(
      'aws:s3/bucketLifecycleConfiguration:BucketLifecycleConfiguration',
    ).filter((c) => c.inputs['bucket'] === 'uploads-id');
    expect(configs).toHaveLength(1);
    return (configs[0] as Recorded).inputs['rules'] as Rule[];
  };

  it('expires uploads after 30 days and noncurrent versions after 1 day', () => {
    const rule = lifecycleRules().find(
      (r) =>
        (r['filter'] as Rule | undefined)?.['prefix'] === 'uploads/' &&
        r['expiration'] !== undefined,
    );
    expect(rule?.['status']).toBe('Enabled');
    expect(rule?.['expiration']).toEqual({ days: 30 });
    expect(rule?.['noncurrentVersionExpiration']).toEqual({
      noncurrentDays: 1,
    });
  });

  it('aborts incomplete multipart uploads after 1 day', () => {
    const rule = lifecycleRules().find(
      (r) => r['abortIncompleteMultipartUpload'] !== undefined,
    );
    expect(rule?.['status']).toBe('Enabled');
    expect(rule?.['abortIncompleteMultipartUpload']).toEqual({
      daysAfterInitiation: 1,
    });
  });

  it('keeps ingestion dead letters for 14 days, less than the upload retention', () => {
    const [dlq] = named('aws:sqs/queue:Queue').filter(
      (q) => q.name === 'ingestion-dlq',
    );
    expect(dlq?.inputs['messageRetentionSeconds']).toBe(14 * 24 * 60 * 60);
  });
});

// Pulumi's wire form of a secret value, as mocks receive it.
const SECRET_SIG = '4dabf18193072939515e22adb298388d';
const isSecret = (value: unknown): value is { value: unknown } =>
  typeof value === 'object' && value !== null && SECRET_SIG in value;
// The inputs with every secret replaced by its value, for structural checks.
const reveal = (value: unknown): unknown => {
  if (isSecret(value)) return reveal(value.value);
  if (Array.isArray(value)) return value.map(reveal);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, reveal(v)]),
    );
  }
  return value;
};

describe('alert guardrails', () => {
  const only = (type: string) => {
    const resources = named(type);
    expect(resources, type).toHaveLength(1);
    return resources[0] as Recorded;
  };
  const revealed = (type: string) =>
    reveal(only(type).inputs) as Record<string, unknown>;

  // The repository is public: the address lives only in encrypted config.
  it('keeps the alert address secret in every resource that uses it', () => {
    const subscription = only('aws:sns/topicSubscription:TopicSubscription');
    expect(isSecret(subscription.inputs['endpoint'])).toBe(true);
    const budget = only('aws:budgets/budget:Budget');
    expect(isSecret(budget.inputs['notifications'])).toBe(true);
    const anomalies = only(
      'aws:costexplorer/anomalySubscription:AnomalySubscription',
    );
    expect(isSecret(anomalies.inputs['subscribers'])).toBe(true);
  });

  it('emails CloudWatch alarms through one SNS topic', () => {
    const topic = only('aws:sns/topic:Topic');
    expect(topic.inputs['name']).toBe('draupnir-prod-alerts');
    expect(
      revealed('aws:sns/topicSubscription:TopicSubscription'),
    ).toMatchObject({
      topic: 'arn:aws:mock:::aws:sns/topic:Topic/alerts',
      protocol: 'email',
      endpoint: 'alerts@example.com',
    });
  });

  it('budgets the whole account at $20 a month, emailing at 100% and 250% actual and 100% forecast', () => {
    const budget = revealed('aws:budgets/budget:Budget');
    expect(budget).toMatchObject({
      name: 'draupnir-prod-monthly',
      budgetType: 'COST',
      timeUnit: 'MONTHLY',
      limitAmount: '20',
      limitUnit: 'USD',
    });
    expect(budget['costFilters']).toBeUndefined();
    expect(budget['notifications']).toEqual(
      [
        ['ACTUAL', 100],
        ['ACTUAL', 250],
        ['FORECASTED', 100],
      ].map(([notificationType, threshold]) => ({
        notificationType,
        threshold,
        comparisonOperator: 'GREATER_THAN',
        thresholdType: 'PERCENTAGE',
        subscriberEmailAddresses: ['alerts@example.com'],
      })),
    );
  });

  it('creates a services anomaly monitor and a daily $5 subscription to it', () => {
    const monitor = only('aws:costexplorer/anomalyMonitor:AnomalyMonitor');
    expect(monitor.inputs).toMatchObject({
      monitorType: 'DIMENSIONAL',
      monitorDimension: 'SERVICE',
    });
    expect(
      revealed('aws:costexplorer/anomalySubscription:AnomalySubscription'),
    ).toMatchObject({
      frequency: 'DAILY',
      monitorArnLists: [
        'arn:aws:mock:::aws:costexplorer/anomalyMonitor:AnomalyMonitor/services',
      ],
      subscribers: [{ type: 'EMAIL', address: 'alerts@example.com' }],
      thresholdExpression: {
        dimension: {
          key: 'ANOMALY_TOTAL_IMPACT_ABSOLUTE',
          matchOptions: ['GREATER_THAN_OR_EQUAL'],
          values: ['5'],
        },
      },
    });
  });

  // Each alarm's QueueName is the physical name the mock gives its queue.
  it.each([
    [
      'ingestion-dlq-messages',
      'ingestion-dlq-physical',
      'ApproximateNumberOfMessagesVisible',
      0,
    ],
    [
      'bot-updates-dlq-messages',
      'draupnir-bot-updates-dlq.fifo',
      'ApproximateNumberOfMessagesVisible',
      0,
    ],
    [
      'bot-outcomes-dlq-messages',
      'bot-outcomes-dlq-physical',
      'ApproximateNumberOfMessagesVisible',
      0,
    ],
    [
      'ingestion-oldest-message-age',
      'ingestion-physical',
      'ApproximateAgeOfOldestMessage',
      3600,
    ],
  ])('alarms %s on %s', (name, queueName, metricName, threshold) => {
    const [alarm] = named('aws:cloudwatch/metricAlarm:MetricAlarm').filter(
      (a) => a.name === name,
    );
    expect(alarm?.inputs).toMatchObject({
      name: `draupnir-prod-${name}`,
      namespace: 'AWS/SQS',
      metricName,
      dimensions: { QueueName: queueName },
      statistic: 'Maximum',
      period: 300,
      evaluationPeriods: 1,
      comparisonOperator: 'GreaterThanThreshold',
      threshold,
      treatMissingData: 'notBreaching',
      alarmActions: ['arn:aws:mock:::aws:sns/topic:Topic/alerts'],
    });
    expect(alarm?.inputs['alarmDescription']).toContain(
      'infra/README.md#alerts',
    );
    // An idle queue's metrics stop, so an "OK" would be misleading.
    expect(alarm?.inputs['okActions']).toBeUndefined();
  });

  it('alarms on every dead-letter queue and nothing else', () => {
    const dlqs = named('aws:sqs/queue:Queue')
      .filter((q) => q.name.endsWith('-dlq'))
      .map((q) => `${q.name}-messages`);
    expect(dlqs.sort()).toEqual([
      'bot-outcomes-dlq-messages',
      'bot-updates-dlq-messages',
      'ingestion-dlq-messages',
    ]);
    expect(
      named('aws:cloudwatch/metricAlarm:MetricAlarm')
        .map((a) => a.name)
        .sort(),
    ).toEqual([...dlqs, 'ingestion-oldest-message-age'].sort());
  });

  it('keeps a waiting upload in the ingestion queue for 14 days', () => {
    const [queue] = named('aws:sqs/queue:Queue').filter(
      (q) => q.name === 'ingestion',
    );
    expect(queue?.inputs['messageRetentionSeconds']).toBe(14 * 24 * 60 * 60);
  });
});
