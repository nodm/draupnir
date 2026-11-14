## Context

See proposal.md for why this change is needed. The current state:

- `infra/` has 13 `aws.lambda.Function` resources, created in 7 places:
  - `cognito.ts`: `pre-sign-up-trigger`
  - `databaseMigrations.ts`: `migrate-database`
  - `ingestionPipeline.ts`: `ingest` and `rebuild-account`
  - `ingestionApi.ts`: `whoami`, written by hand
  - `lambdaRoute.ts`: the `createLambdaRoute` functions `accounts`, `presigned-upload` and `mcp`
  - `mcpApi.ts`: `mcp-oauth`
  - `bot.ts`: `bot-webhook`, `bot-callback`, `bot-worker` and `bot-retention`, through a local `lambdaFunction` helper
- All 13 functions are autonamed by Pulumi, for example `ingest-1a2b3c4`. Their default log groups are therefore `/aws/lambda/<random-suffixed-name>`. Nothing in the program knows those names; they exist only in the stack state and in AWS.
- The program has no `aws.cloudwatch.*` resources at all: no log groups, metric filters or subscriptions. Nothing besides people reading logs depends on the current group names. The only place the names appear is the troubleshooting section of `docs/telegram-bot.md`.
- Every role attaches `AWSLambdaBasicExecutionRole` (`LAMBDA_BASIC_EXECUTION_POLICY_ARN`). That managed policy allows `logs:CreateLogGroup`, `logs:CreateLogStream` and `logs:PutLogEvents` on `Resource: "*"`.
- `migrate-database` is invoked during `pulumi up` by an `aws.lambda.Invocation`. The pre-sign-up trigger and the SQS consumers can be invoked as soon as they exist.

## Goals / Non-Goals

**Goals:**

- Retention on all 13 log groups, set from one config value.
- A single code path for creating Lambda functions, with a test that catches any function that bypasses it.
- A first deploy that cannot fail because a log group already exists, and later deploys that are routine.

**Non-Goals:**

- Reducing ingestion volume. Switching to JSON format or filtering by log level is evaluated in Decision 5 and put off.
- The Infrequent Access log class, metric filters, alarms, and log export to S3.
- Log groups that are not Lambda's, such as API Gateway access logs. None are enabled today.

## Decisions

### 1. Option (b): new named log groups attached with `loggingConfig.logGroup`, not imports

Each function gets a new `aws.cloudwatch.LogGroup` named `/aws/lambda/draupnir/<stack>/<logical-name>`, for example `/aws/lambda/draupnir/prod/bot-worker`. The function points at it with `loggingConfig: { logFormat: 'Text', logGroup: logGroup.name }`.

Reasons this is better than option (a), which is to import the existing `/aws/lambda/<physical>` groups:

- **No dependency on state or ordering.** Under (a), each LogGroup name derives from `fn.name`, an output that is only known after the function exists. That causes two failures:
  - Lambda can create the default group before Pulumi does. This happens with the `migrate-database` Invocation during the same `up`, an SQS message, or a Cognito sign-up. Pulumi's create then fails with `ResourceAlreadyExistsException`.
  - On a fresh stack, and every time a function is replaced (renamed or a type change), the problem returns. Every function would need careful `dependsOn` wiring.

  Under (b), the group name does not depend on the function. The group is created first (the function's input references it), so the function never writes to a group that Pulumi does not own.
- **No one-off import ceremony.** Under (a), you have to look up the 13 physical names, write an import file, and run `pulumi import --generate-code=false`. The import must match the program's URNs exactly, or the next `up` deletes or duplicates groups. Option (b) only needs one manual delete, and the delete is safe to run late, or never. Leftover groups cost storage but break nothing.
- **Readable, stable names.** `aws logs tail /aws/lambda/draupnir/prod/bot-worker` works without first looking up the random suffix. This simplifies the troubleshooting docs.
- **Including the stack in the name** keeps two stacks in one account from colliding. The `/aws/lambda/` prefix keeps the groups next to the other Lambda groups in the console.

**IAM check:** `AWSLambdaBasicExecutionRole` grants the three log actions on `Resource: "*"`, so writing to a group with a custom name needs no policy change. The implementation re-reads the policy (`aws iam get-policy-version --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole --version-id $(aws iam get-policy --policy-arn … --query Policy.DefaultVersionId --output text)`) before the deploy, in case AWS has narrowed it. If AWS ever scopes it to `/aws/lambda/<function>*`, the fix is a policy in the same constructor that grants `logs:CreateLogStream` and `logs:PutLogEvents` on the function's own group ARN.

**Trade-off accepted:** the old groups hold the history up to the deploy and receive nothing afterwards. They are deleted by hand (see Migration Plan).

### 2. One shared constructor, `createLambdaFunction`

A new `infra/lib/lambdaFunction.ts` exports `createLambdaFunction(name, args, opts)`:

- `args` is `aws.lambda.FunctionArgs` without `loggingConfig`, so callers cannot set or override it.
- It creates `new aws.cloudwatch.LogGroup(name, { name: '/aws/lambda/draupnir/<stack>/<name>', retentionInDays })`. The logical name equals the function's, which is allowed because the resource type is different. The log group gets only `opts.provider`, not the function's `dependsOn`, so log groups never wait on migrations.
- It then creates the `aws.lambda.Function` with the log group's `loggingConfig` and returns the function.

All 7 call sites switch to it, including `createLambdaRoute` and the `lambdaFunction` helper in `bot.ts`. `whoami` keeps its hand-written block but calls the constructor. Every existing logical function name stays the same, so Pulumi sees an in-place update of `loggingConfig` and no replacement.

**Enforcement:** the program-wide test in `guardrails.spec.ts` asserts that every recorded `aws:lambda/function:Function` has `loggingConfig.logGroup` equal to the name of a recorded `aws:cloudwatch/logGroup:LogGroup` whose `retentionInDays` is the configured value. It also asserts that the set of function names is exactly the 13 known ones. The test covers any construction path, so it is the real guarantee. A lint rule (`no-restricted-syntax` on `new aws.lambda.Function`) was considered and dropped: it only covers one syntax form, and the test already fails.

### 3. Retention config: `draupnir-infra:logRetentionDays`, default 30, validated

`infra/lib/logRetention.ts` follows the pattern of `retentionSchedule.ts`. It exports `LOG_RETENTION_CONFIG_KEY`, `DEFAULT_LOG_RETENTION_DAYS = 30`, and a `logRetentionDays(value: string | undefined): number` function. That function accepts only the values that CloudWatch Logs allows (1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653). Any other value throws, with the key and the accepted list in the message, so the preview fails instead of the `up` failing halfway through. The constructor reads the config once per call through `new pulumi.Config().get('logRetentionDays')`. A value of 0 ("Never expire") is deliberately not accepted.

30 days covers the debugging window that matters here: a statement upload or bot problem is noticed within days. Storage stays at about one month of ingestion.

### 4. `logFormat: 'Text'` stays explicit

`loggingConfig.logFormat` is required by the provider whenever `loggingConfig` is set. `'Text'` keeps today's output byte for byte, so the only behavior change in this change is where logs are written and for how long.

### 5. Evaluated and put off: JSON log format with an application log level of WARN in prod

What the switch would do:

- `logFormat: 'JSON'` with `applicationLogLevel: 'WARN'` makes Lambda drop `console.log`/`console.info`/`console.debug` lines before they are ingested.
- `systemLogLevel: 'WARN'` would also drop the platform's `START`/`END`/`REPORT` lines. For short invocations, these are a large share of all lines.

Reasons to put it off:

- **Volume is already bounded and small.** Ingestion is limited by the API throttles and the concurrency caps (at most 10 concurrent executions) and by a single-user workload. The unbounded part was storage, and retention fixes that. The savings would be cents per month.
- **It would drop useful records.** The info-level lines are deliberate operational records:
  - `retention-swept` summaries (`bot/src/retention.ts:35`)
  - the MCP request description (`mcp/src/handler.ts:110`)
  - the ingest progress line (`ingestion/src/handler.ts:49`)
  - the migration runner's progress (`infra/src/migrateDatabase.ts:53`)

  Keeping them at WARN would mean moving them to `console.warn`, which mislabels their level.
- **Double encoding.** The handlers log with `console.x(JSON.stringify({...}))`. Under the JSON format, the Node.js runtime wraps each line in its own object (`timestamp`, `level`, `requestId`, `message`), and a string argument ends up as the `message` string. The handlers' fields would then be an escaped string inside `message` instead of top-level fields, which makes Logs Insights queries worse until the handlers pass objects instead of strings. This should be confirmed against the runtime before adopting the switch. Either way, adopting it is its own change, touching handler code across `bot`, `ingestion`, `mcp` and `shared`.
- **Cheap to adopt later.** Because every function goes through `createLambdaFunction`, a follow-up change can switch the format and levels (optionally per stack, through config) in one place.

## Risks / Trade-offs

- [`AWSLambdaBasicExecutionRole` might no longer cover custom group names] → It is checked before the deploy (Decision 1). If it falls short, a scoped inline policy is added in the constructor. Writes to the new group would show up as missing, never as an error to callers, so the deploy is verified by tailing each new group (Migration Plan step 3).
- [Lambda recreates a deleted managed group without retention] → The roles keep `logs:CreateLogGroup`, so if someone deletes a managed group by hand, Lambda recreates it without retention. `pulumi refresh` followed by `up` restores it. This is accepted rather than dropping `logs:CreateLogGroup` from the roles, which would need a custom policy in place of the managed one on all 13 roles.
- [Logs split across two groups during the transition] → For one deploy, history is in the old group and new events are in the new one. The cleanup is delayed until the new groups are confirmed to receive events. Anyone who needs the old history can keep the old groups for a while by setting retention on them (see the Migration Plan alternative).
- [Destroying the stack deletes the log groups and their history] → This is the intended ownership. `retainOnDelete` is not used.
- [Rollback] → Reverting the code removes `loggingConfig`. The provider may not reset a function's log group to the default when the block is removed, and could leave functions pointing at deleted groups, which Lambda would then recreate without retention. The preferred rollback is to change `logRetentionDays` rather than revert the change. If a revert is unavoidable, check `aws lambda get-function-configuration --query LoggingConfig` afterwards.

## Migration Plan

1. Before deploying, re-read `AWSLambdaBasicExecutionRole` (Decision 1) and confirm that `Resource` is `"*"` for the log actions.
2. Run `pnpm exec nx run infra:preview`. Expect 13 LogGroup creates and 13 Function updates (`loggingConfig` only), with no replacements. Then run `pnpm exec nx run infra:up`.
3. Verify: invoke or exercise one function per area (a bot message, an API call), then check `aws logs describe-log-groups --log-group-name-prefix /aws/lambda/draupnir/prod/ --query 'logGroups[].[logGroupName,retentionInDays]'` (13 groups, each with retention 30). Tail at least one group with `aws logs tail /aws/lambda/draupnir/prod/bot-webhook --since 10m`.
4. One-off cleanup: delete the old groups of this stack's functions only. Take the physical function names from the stack state, not from `list-functions` or a prefix, because the account may hold other functions and `/aws/lambda/` groups:

   ```bash
   cd infra
   for fn in $(pulumi stack export | jq -r '.deployment.resources[]
       | select(.type == "aws:lambda/function:Function") | .outputs.name'); do
     group="/aws/lambda/$fn"
     aws logs describe-log-groups --log-group-name-prefix "$group" \
       --query "logGroups[?logGroupName=='$group'].logGroupName" --output text | grep -q . \
       && echo "delete $group"   # review the 13 lines, then swap echo for: aws logs delete-log-group --log-group-name "$group"
   done
   ```

   **Alternative, to keep recent history:** run `aws logs put-retention-policy --log-group-name "$group" --retention-in-days 30` instead of deleting, then delete the emptied groups later.
5. Rollback: see Risks. Prefer changing `logRetentionDays` to reverting.
