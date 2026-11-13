import * as pulumi from '@pulumi/pulumi';

// The whole program against recorded mocks, as in bot.spec.ts. Pins the account
// concurrency guardrails (cost-guardrails spec): the three SQS mappings are
// capped, and no function uses reserved concurrency (the account quota of 10
// equals AWS's unreserved floor, so none could be set; design decision 1).

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
    'draupnir-infra:authDomainPrefix': 'auth-prefix',
    'draupnir-infra:mcpHost': 'mcp.example.com',
    'draupnir-infra:mcpHostedZone': 'example.com',
    'google:clientId': 'client-id',
    'google:clientSecret': 'client-secret',
  });

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
  // Resources register asynchronously; wait until every one has.
  await pulumi.runtime.disconnect();
});

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
