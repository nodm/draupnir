## ADDED Requirements

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
