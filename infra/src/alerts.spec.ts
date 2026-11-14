import * as pulumi from '@pulumi/pulumi';
import { budgetMonthlyUsd } from '../lib/alerts';

describe('budgetMonthlyUsd', () => {
  it('defaults to $20 when the key is not set', () => {
    expect(budgetMonthlyUsd(undefined)).toBe(20);
    expect(budgetMonthlyUsd('')).toBe(20);
    expect(budgetMonthlyUsd('  ')).toBe(20);
  });

  it('accepts a positive amount, including cents', () => {
    expect(budgetMonthlyUsd('40')).toBe(40);
    expect(budgetMonthlyUsd(' 12.5 ')).toBe(12.5);
  });

  it.each(['0', '-5', 'abc', 'Infinity', 'NaN'])(
    'refuses %s, naming the config key',
    (value) => {
      expect(() => budgetMonthlyUsd(value)).toThrow(
        /draupnir-infra:budgetMonthlyUsd/,
      );
    },
  );
});

// createAlerts alone, against recorded mocks, with config the whole-program
// run in guardrails.spec.ts does not use: a reused anomaly monitor, a
// configured budget, and no alert recipient at all.
describe('createAlerts with non-default config', () => {
  interface Recorded {
    type: string;
    name: string;
    inputs: Record<string, unknown>;
  }
  const recorded: Recorded[] = [];
  const named = (type: string) => recorded.filter((r) => r.type === type);
  const EXISTING_MONITOR =
    'arn:aws:ce::123456789012:anomalymonitor/existing-monitor';
  let missingRecipientError: unknown;

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
              name: `${args.name}-physical`,
              ...args.inputs,
              arn: `arn:aws:mock:::${args.type}/${args.name}`,
            },
          };
        },
        call: (args) => args.inputs,
      },
      'draupnir-infra',
      'prod',
      false,
    );
    const aws = await import('@pulumi/aws');
    const { createAlerts } = await import('../lib/alerts');
    const provider = new aws.Provider('aws', { region: 'eu-north-1' });
    const queue = (name: string) => new aws.sqs.Queue(name, {}, { provider });
    const queues = {
      ingestion: queue('ingestion'),
      ingestionDlq: queue('ingestion-dlq'),
      botUpdatesDlq: queue('bot-updates-dlq'),
      botOutcomesDlq: queue('bot-outcomes-dlq'),
    };

    // `setAllConfig` replaces the whole config, so each run sees only its own.
    pulumi.runtime.setAllConfig({ 'aws:region': 'eu-north-1' });
    try {
      createAlerts(provider, queues);
    } catch (error) {
      missingRecipientError = error;
    }

    pulumi.runtime.setAllConfig({
      'aws:region': 'eu-north-1',
      'draupnir-infra:alertEmail': 'alerts@example.com',
      'draupnir-infra:budgetMonthlyUsd': '40',
      'draupnir-infra:anomalyMonitorArn': EXISTING_MONITOR,
    });
    createAlerts(provider, queues);
    await pulumi.runtime.disconnect();
  }, 60_000);

  it('refuses to build without an alert recipient, naming the key', () => {
    expect(missingRecipientError).toBeInstanceOf(Error);
    expect((missingRecipientError as Error).message).toContain(
      'draupnir-infra:alertEmail',
    );
  });

  it('creates nothing when the recipient is missing', () => {
    // Only the provider and the four queues exist besides the second run's
    // resources: exactly one topic, budget and anomaly subscription.
    expect(named('aws:sns/topic:Topic')).toHaveLength(1);
    expect(named('aws:budgets/budget:Budget')).toHaveLength(1);
  });

  it('reuses the configured anomaly monitor instead of creating one', () => {
    expect(named('aws:costexplorer/anomalyMonitor:AnomalyMonitor')).toEqual(
      [],
    );
    const subscriptions = named(
      'aws:costexplorer/anomalySubscription:AnomalySubscription',
    );
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]?.inputs['monitorArnLists']).toEqual([
      EXISTING_MONITOR,
    ]);
  });

  it('uses the configured monthly limit', () => {
    const [budget] = named('aws:budgets/budget:Budget');
    expect(budget?.inputs['limitAmount']).toBe('40');
  });
});
