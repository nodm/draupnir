import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';

// Spend and failure alerts: an account-wide monthly budget, a cost anomaly
// subscription, and alarms on the dead-letter queues and the ingestion backlog.
// The guardrails cap how fast the stack can spend; these say when it does. See
// openspec/changes/archive/2026-11-14-add-spend-alarms/design.md (decisions 1-7).

export const BUDGET_CONFIG_KEY = 'draupnir-infra:budgetMonthlyUsd';
export const DEFAULT_BUDGET_MONTHLY_USD = 20;

// Percent of the monthly limit: a warning, an "act now" step at 2.5x, and a
// forecast that warns before the month is out.
export const BUDGET_NOTIFICATIONS = [
  { notificationType: 'ACTUAL', threshold: 100 },
  { notificationType: 'ACTUAL', threshold: 250 },
  { notificationType: 'FORECASTED', threshold: 100 },
] as const;

// Smallest total impact, in USD, of an anomaly that is reported.
export const ANOMALY_IMPACT_THRESHOLD_USD = 5;

// SQS alarms evaluate one 5-minute period: an arrival is reported within the
// period plus metric delay.
const ALARM_PERIOD_SECONDS = 300;

// A file that fails every attempt is dead-lettered after at most 4 visibility
// timeouts (540 s) and 5 runs (90 s), about 44 minutes. Older than an hour is a
// backlog, not a retry; a poison message is the DLQ alarm's job.
export const INGESTION_BACKLOG_AGE_SECONDS = 60 * 60;

// Returns the monthly limit in USD, or throws so that `pulumi preview` fails
// before any resource changes.
export function budgetMonthlyUsd(value: string | undefined): number {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_BUDGET_MONTHLY_USD;
  }
  const amount = Number(value.trim());
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(
      `${BUDGET_CONFIG_KEY} "${value}" must be a positive number of US dollars`,
    );
  }
  return amount;
}

export interface AlertQueues {
  ingestion: aws.sqs.Queue;
  ingestionDlq: aws.sqs.Queue;
  botUpdatesDlq: aws.sqs.Queue;
  botOutcomesDlq: aws.sqs.Queue;
}

export interface Alerts {
  topic: aws.sns.Topic;
  budget: aws.budgets.Budget;
  alarms: aws.cloudwatch.MetricAlarm[];
}

const README = 'infra/README.md#alerts';

export function createAlerts(
  provider: aws.Provider,
  queues: AlertQueues,
): Alerts {
  const config = new pulumi.Config();
  const stack = pulumi.getStack();
  const withProvider = { provider };
  // Secret config: the address never appears in the repository.
  const alertEmail = config.requireSecret('alertEmail');
  const prefix = `draupnir-${stack}`;

  // --- CloudWatch alarms -> SNS -> email (decision 1) ----------------------
  const topic = new aws.sns.Topic(
    'alerts',
    { name: `${prefix}-alerts` },
    withProvider,
  );
  // Needs a one-time confirmation from the email (README, Alerts).
  new aws.sns.TopicSubscription(
    'alerts-email',
    { topic: topic.arn, protocol: 'email', endpoint: alertEmail },
    withProvider,
  );

  // --- Budget: whole account, emailed directly (decisions 1-2) -------------
  const limit = budgetMonthlyUsd(config.get('budgetMonthlyUsd'));
  const budget = new aws.budgets.Budget(
    'monthly',
    {
      name: `${prefix}-monthly`,
      budgetType: 'COST',
      timeUnit: 'MONTHLY',
      limitAmount: String(limit),
      limitUnit: 'USD',
      // No cost filters: everything in the account is billed to the same card.
      notifications: BUDGET_NOTIFICATIONS.map((n) => ({
        notificationType: n.notificationType,
        comparisonOperator: 'GREATER_THAN',
        threshold: n.threshold,
        thresholdType: 'PERCENTAGE',
        subscriberEmailAddresses: [alertEmail],
      })),
    },
    withProvider,
  );

  // --- Cost anomalies (decision 3) -----------------------------------------
  // AWS allows one services monitor per account: reuse an existing one by ARN
  // rather than importing (and so owning) it.
  const existingMonitorArn = config.get('anomalyMonitorArn');
  const monitorArn: pulumi.Input<string> =
    existingMonitorArn ??
    new aws.costexplorer.AnomalyMonitor(
      'services',
      {
        name: `${prefix}-services`,
        monitorType: 'DIMENSIONAL',
        monitorDimension: 'SERVICE',
      },
      withProvider,
    ).arn;
  new aws.costexplorer.AnomalySubscription(
    'anomalies',
    {
      name: `${prefix}-anomalies`,
      frequency: 'DAILY',
      monitorArnLists: [monitorArn],
      subscribers: [{ type: 'EMAIL', address: alertEmail }],
      thresholdExpression: {
        dimension: {
          key: 'ANOMALY_TOTAL_IMPACT_ABSOLUTE',
          matchOptions: ['GREATER_THAN_OR_EQUAL'],
          values: [String(ANOMALY_IMPACT_THRESHOLD_USD)],
        },
      },
    },
    withProvider,
  );

  // --- Queue alarms (decisions 4-5) ----------------------------------------
  // No okActions: SQS stops publishing metrics for a queue idle for ~6 hours,
  // so a DLQ still holding a message would later read as "OK".
  const queueAlarm = (
    name: string,
    queue: aws.sqs.Queue,
    metricName: string,
    threshold: number,
    description: string,
  ) =>
    new aws.cloudwatch.MetricAlarm(
      name,
      {
        name: `${prefix}-${name}`,
        alarmDescription: `${description} See ${README}.`,
        namespace: 'AWS/SQS',
        metricName,
        dimensions: { QueueName: queue.name },
        statistic: 'Maximum',
        period: ALARM_PERIOD_SECONDS,
        evaluationPeriods: 1,
        comparisonOperator: 'GreaterThanThreshold',
        threshold,
        treatMissingData: 'notBreaching',
        alarmActions: [topic.arn],
      },
      withProvider,
    );

  const deadLetter = (name: string, queue: aws.sqs.Queue, what: string) =>
    queueAlarm(
      `${name}-messages`,
      queue,
      'ApproximateNumberOfMessagesVisible',
      0,
      `A message reached ${name}: ${what}`,
    );

  const alarms = [
    deadLetter(
      'ingestion-dlq',
      queues.ingestionDlq,
      'a statement file failed every processing attempt and was not imported.',
    ),
    deadLetter(
      'bot-updates-dlq',
      queues.botUpdatesDlq,
      'a Telegram message or button press failed every attempt and was not handled.',
    ),
    deadLetter(
      'bot-outcomes-dlq',
      queues.botOutcomesDlq,
      'a statement result could not be reported to the chat (the retention run retries it for 48 hours).',
    ),
    queueAlarm(
      'ingestion-oldest-message-age',
      queues.ingestion,
      'ApproximateAgeOfOldestMessage',
      INGESTION_BACKLOG_AGE_SECONDS,
      'Statement files have waited in the ingestion queue for over an hour: processing is stuck or swamped.',
    ),
  ];

  return { topic, budget, alarms };
}
