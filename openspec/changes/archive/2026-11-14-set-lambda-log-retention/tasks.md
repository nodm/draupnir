## 1. Retention config and shared constructor

- [x] 1.1 Add `infra/lib/logRetention.ts` (`LOG_RETENTION_CONFIG_KEY`, `DEFAULT_LOG_RETENTION_DAYS = 30`, `logRetentionDays(value)`, which accepts only the CloudWatch Logs retention values and throws naming the key and listing the accepted values). Unit tests cover: undefined → 30, `'14'` → 14, and `'45'`, `'0'` and `'abc'` throw an error that names `draupnir-infra:logRetentionDays`. Verify with `pnpm exec nx test infra`.
- [x] 1.2 Add `infra/lib/lambdaFunction.ts` with `createLambdaFunction(name, args, opts)`. `args` omits `loggingConfig`. The function creates an `aws.cloudwatch.LogGroup` with logical name `name` and physical name `/aws/lambda/draupnir/<stack>/<name>`, using `retentionInDays` from the config and only `opts.provider`, then creates the function with `loggingConfig: { logFormat: 'Text', logGroup: logGroup.name }`. Verify with `pnpm exec nx run infra:typecheck` (or `infra:build` if there is no typecheck target; check with `pnpm exec nx show project infra`).

## 2. Route every Lambda through the constructor

- [x] 2.1 Switch `createLambdaRoute` (`infra/lib/lambdaRoute.ts`) to `createLambdaFunction`. This covers `accounts`, `presigned-upload` and `mcp`. Verify that the existing infra tests still pass.
- [x] 2.2 Switch the local `lambdaFunction` helper in `infra/lib/bot.ts` to `createLambdaFunction`. This covers `bot-webhook`, `bot-callback`, `bot-worker` and `bot-retention`. Keep the `dependsOn` on the function only. Verify that `infra/src/bot.spec.ts` passes.
- [x] 2.3 Switch `pre-sign-up-trigger` (`cognito.ts`), `migrate-database` (`databaseMigrations.ts`), `ingest` and `rebuild-account` (`ingestionPipeline.ts`), `whoami` (`ingestionApi.ts`) and `mcp-oauth` (`mcpApi.ts`) to `createLambdaFunction`, keeping every logical name. Verify that `grep -rn "new aws.lambda.Function" infra/lib` matches only `lambdaFunction.ts`.

## 3. Guardrail tests

- [x] 3.1 In `infra/src/guardrails.spec.ts`, assert that the recorded `aws:lambda/function:Function` names are exactly the 13 expected functions, that each has `loggingConfig.logFormat === 'Text'`, and that each has `loggingConfig.logGroup` equal to `/aws/lambda/draupnir/prod/<name>`. Also assert that a recorded `aws:cloudwatch/logGroup:LogGroup` with that name exists with `retentionInDays === 30`. Update the header comment to mention log retention. Verify with `pnpm exec nx test infra`.
- [x] 3.2 Temporarily add a bare `new aws.lambda.Function` to the program (or remove `loggingConfig` in the constructor) and confirm that the test from 3.1 fails, then revert. Verify by recording the failing assertion output in the PR description.

## 4. Documentation and spec

- [x] 4.1 In `infra/README.md`:
  - Add a "Log retention" section next to "API guardrails". It covers the `/aws/lambda/draupnir/<stack>/<function>` pattern, an `aws logs tail` example, `logRetentionDays` (default 30, the accepted values, `pulumi config set logRetentionDays 14`), and the one-off cleanup command from design.md.
  - List the optional key under "Required stack config", next to `callbackUrl`/`logoutUrl`.

  Verify that the section renders, that the commands match design.md, and that `pnpm exec prettier --check infra/README.md` passes.
- [x] 4.2 Update the troubleshooting lines in `docs/telegram-bot.md` to `aws logs tail /aws/lambda/draupnir/prod/bot-<name> --since 1h`, dropping the `list-functions` lookup. Verify that `grep -rn "/aws/lambda/<name>" docs infra` returns nothing.
- [x] 4.3 Run `pnpm exec openspec validate set-lambda-log-retention --strict` and confirm that it passes.

## 5. Full checks

- [x] 5.1 Run `pnpm exec nx run-many -t lint test typecheck -p infra` (use the targets that exist) and confirm that everything passes.

## 6. Deploy and one-off cleanup (manual, by the maintainer)

- [x] 6.1 Re-read `AWSLambdaBasicExecutionRole` (`aws iam get-policy-version`, design.md Decision 1) and confirm that the log actions are allowed on `Resource: "*"`. If they are not, add a scoped log policy in `createLambdaFunction` before deploying.
- [x] 6.2 Run `pnpm exec nx run infra:preview` and confirm 13 LogGroup creates and 13 Function in-place updates, with no replacements. Then run `pnpm exec nx run infra:up`.
- [x] 6.3 Exercise the bot and the API, then confirm with `aws logs describe-log-groups --log-group-name-prefix /aws/lambda/draupnir/prod/` that there are 13 groups with retention 30 and that new events arrive (for example, `aws logs tail /aws/lambda/draupnir/prod/bot-webhook --since 10m`).
- [x] 6.4 Run the cleanup loop from design.md (Migration Plan step 4) with `echo`, review the 13 old `/aws/lambda/<physical-name>` groups, then delete them (or set their retention to 30 to keep recent history). Verify that the loop then prints nothing.
