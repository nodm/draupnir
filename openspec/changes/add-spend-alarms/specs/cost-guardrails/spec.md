## ADDED Requirements

### Requirement: Monthly account spend is reported against a budget
The deployment SHALL create a monthly cost budget that covers all spend in the AWS account, not only this stack's resources. The budget limit SHALL be read in US dollars from the Pulumi config key `draupnir-infra:budgetMonthlyUsd` and SHALL default to 20 when the key is not set. An email SHALL be sent to the alert recipient each time one of these thresholds is first crossed in a calendar month:
- actual spend reaches 100% of the limit;
- actual spend reaches 250% of the limit;
- forecast spend for the month reaches 100% of the limit.

The alert recipient's address SHALL come from the secret Pulumi config key `draupnir-infra:alertEmail` and SHALL NOT appear in the repository.

#### Scenario: Default thresholds
- **WHEN** the stack is deployed without `draupnir-infra:budgetMonthlyUsd` set
- **THEN** the budget's monthly limit is $20, and the alert recipient gets an email when actual spend reaches $20, again when it reaches $50, and when the month's forecast reaches $20

#### Scenario: Configured limit
- **WHEN** `draupnir-infra:budgetMonthlyUsd` is set to 40 and the stack is deployed
- **THEN** the actual-spend emails are sent at $40 and $100, and the forecast email at $40

#### Scenario: Spend outside the stack counts
- **WHEN** a resource that this stack does not manage adds cost to the account
- **THEN** that cost counts toward the budget

### Requirement: Cost anomalies are reported
The account SHALL have a cost anomaly monitor that covers AWS services. The alert recipient SHALL receive a daily email summary of the anomalies whose total cost impact is at least $5. If the account already has a monitor for AWS services, the deployment SHALL subscribe the recipient to that monitor and SHALL NOT create a second one.

#### Scenario: Anomaly reported
- **WHEN** Cost Anomaly Detection finds an anomaly with a total impact of $5 or more
- **THEN** the alert recipient gets it in the next daily summary email

#### Scenario: Existing monitor reused
- **WHEN** the account already has an AWS services anomaly monitor and its ARN is given in config
- **THEN** the deployment creates only the subscription to that monitor, and the account still has exactly one AWS services monitor

### Requirement: A dead-lettered message raises an alarm
Each dead-letter queue of the stack (ingestion, Telegram updates and statement outcomes) SHALL have an alarm. The alarm SHALL go into alarm state and notify the alert recipient by email within 10 minutes of at least one message becoming visible in that queue. An empty queue, or a queue with no recent metrics, SHALL NOT count as alarming.

#### Scenario: Ingestion file dead-lettered
- **WHEN** a statement file's message is moved to the ingestion dead-letter queue
- **THEN** the alert recipient gets an alarm email that names that queue

#### Scenario: Idle dead-letter queues stay quiet
- **WHEN** all dead-letter queues are empty and have had no activity for days
- **THEN** none of their alarms are in alarm state

### Requirement: An ingestion backlog raises an alarm
The ingestion queue SHALL have an alarm that goes into alarm state and notifies the alert recipient by email when its oldest message is older than 1 hour. The threshold SHALL be longer than the longest time a single file can wait through its normal retries before it is dead-lettered, so that a slow retry alone never triggers the alarm.

#### Scenario: Backlog detected
- **WHEN** messages wait in the ingestion queue and the oldest is more than 1 hour old
- **THEN** the alert recipient gets an alarm email that names the ingestion queue

#### Scenario: Retries alone do not alarm
- **WHEN** one file fails on every attempt until it is moved to the dead-letter queue, with no other messages waiting
- **THEN** the backlog alarm does not go into alarm state (the dead-letter alarm does)

### Requirement: Missing or invalid alert config is rejected before deploy
`pulumi preview` and `pulumi up` SHALL fail before any resource changes when any of these holds:
- `draupnir-infra:alertEmail` is not set;
- `draupnir-infra:budgetMonthlyUsd` is set to something that is not a positive number.

The error message SHALL name the config key.

#### Scenario: Recipient missing
- **WHEN** the stack has no `draupnir-infra:alertEmail` and a preview runs
- **THEN** the preview fails with an error that names `draupnir-infra:alertEmail`, and nothing is deployed

#### Scenario: Invalid budget
- **WHEN** `draupnir-infra:budgetMonthlyUsd` is set to `0`, `-5` or `abc`
- **THEN** the preview fails with an error that names `draupnir-infra:budgetMonthlyUsd`, and nothing is deployed

### Requirement: Alerts are documented
The infra documentation SHALL state:
- the alert config keys and their defaults;
- that the budget covers the whole account;
- the one-time confirmation of the email subscription after the first deploy;
- how to reuse an existing anomaly monitor;
- for each alarm, what it means and where to look first.

#### Scenario: Maintainer receives an alarm
- **WHEN** a maintainer gets a dead-letter or backlog alarm email and opens `infra/README.md`
- **THEN** the Alerts section names the affected queue's purpose and the first command to inspect it
