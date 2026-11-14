# cost-guardrails Specification

## Purpose

Keeps a backlog in one of the queues from using up the account's Lambda capacity, records the account-level concurrency ceiling that bounds the rest, and keeps every Lambda function's logs for a bounded period, so that spend has an upper limit that does not depend on callers behaving. It also emails the maintainer when spend or cost anomalies cross set thresholds and when messages are dead-lettered or back up, so that spending within those limits, and quiet failures, are noticed.

## Requirements

### Requirement: Queue-driven functions are capped at the event source mapping
Each SQS event source mapping SHALL set a maximum concurrency of 2: the `ingest` mapping, the `bot-worker` mapping on the Telegram updates queue and the `bot-worker` mapping on the statement outcomes queue. The cap is per mapping, so the Telegram bot's worker MAY run up to 4 invocations at once. Queue-driven functions SHALL NOT use reserved concurrency for this purpose, so that a message is never received and then throttled.

#### Scenario: A backlog is drained at the cap
- **WHEN** a backlog builds on a capped queue
- **THEN** at most 2 invocations per mapping run at once, the rest of the backlog stays in the queue, and no message is moved to the dead-letter queue because of the cap

#### Scenario: Telegram updates of one chat stay in order
- **WHEN** several updates of one chat are queued while the cap is in effect
- **THEN** they are still handled one at a time in the order they were sent, and updates of other chats can run in parallel up to the cap

#### Scenario: Queue consumers leave capacity for other functions
- **WHEN** every capped mapping is running at its cap
- **THEN** the queue consumers use at most 6 concurrent executions, so that with the account's quota of 10, at least 4 remain for the API functions and the Cognito pre-sign-up trigger

### Requirement: The account concurrency ceiling is recorded
The documentation SHALL state the account's Lambda concurrent-executions quota, the date it was read, and that it is an AWS setting that this repository does not control. It SHALL also state that if the quota changes, the queue cap and the unused option of per-function reservations (which need the quota to exceed their sum by 10) are to be revisited.

#### Scenario: Documentation names the quota
- **WHEN** a maintainer reads the architecture documentation
- **THEN** it gives the quota (10), the date it was read (2026-11-13) and the instruction to re-check it with `aws lambda get-account-settings` before relying on it

### Requirement: Every Lambda function's logs have bounded retention
Every Lambda function in the stack SHALL send its logs to a log group that the deployment creates and owns. That group SHALL be named `/aws/lambda/draupnir/<stack>/<function>`, where `<function>` is the function's logical name, and SHALL have a retention period equal to the configured log retention. The log retention SHALL be read from the Pulumi config key `draupnir-infra:logRetentionDays` and SHALL default to 30 days when the key is not set. This SHALL hold for every function, including functions added later. No function SHALL depend on the log group that Lambda creates automatically.

#### Scenario: Default retention
- **WHEN** the stack is deployed without `draupnir-infra:logRetentionDays` set
- **THEN** every Lambda function writes to its `/aws/lambda/draupnir/<stack>/<function>` group, and each of those groups has a retention of 30 days

#### Scenario: Configured retention
- **WHEN** `draupnir-infra:logRetentionDays` is set to 14 and the stack is deployed
- **THEN** every function's log group has a retention of 14 days, and no function is replaced

#### Scenario: A new function cannot skip retention
- **WHEN** a Lambda function is added to the program without a managed log group that has the configured retention
- **THEN** the infra guardrail tests fail

#### Scenario: Old events expire
- **WHEN** a log event is older than the configured retention
- **THEN** CloudWatch Logs deletes it, and it no longer counts toward stored log bytes

### Requirement: Invalid log retention is rejected before deploy
A `draupnir-infra:logRetentionDays` value that is not one of the retention periods CloudWatch Logs accepts SHALL fail `pulumi preview` and `pulumi up` before any resource changes. The error message SHALL name the config key.

#### Scenario: Unsupported value
- **WHEN** `draupnir-infra:logRetentionDays` is set to `45`, or to a value that is not a number
- **THEN** the preview fails with an error that names `draupnir-infra:logRetentionDays` and lists the accepted values, and nothing is deployed

### Requirement: No function log group keeps events forever
After this guardrail is first deployed, the log groups that Lambda created automatically for the stack's functions (`/aws/lambda/<physical-function-name>`) SHALL be deleted by a documented one-off step, so that no log group of the stack's functions is left with retention "Never expire".

#### Scenario: Cleanup after the first deploy
- **WHEN** the change is deployed, new log events are confirmed to arrive in the `/aws/lambda/draupnir/<stack>/` groups, and the documented cleanup step is run
- **THEN** no `/aws/lambda/<physical-function-name>` group of a current stack function remains, and every remaining log group of the stack's functions has a finite retention

### Requirement: Log retention and locations are documented
The infra documentation SHALL state the log retention config key, its default and accepted values, the naming pattern of the function log groups with an example command that tails one, and the one-off cleanup of the old groups.

#### Scenario: Maintainer looks for a function's logs
- **WHEN** a maintainer reads `infra/README.md` to find a function's logs
- **THEN** it gives the `/aws/lambda/draupnir/<stack>/<function>` pattern, an `aws logs tail` example, the retention default of 30 days and how to change it with `pulumi config set logRetentionDays`

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
