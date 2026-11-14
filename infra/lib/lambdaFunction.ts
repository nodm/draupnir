import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import { logRetentionDays } from './logRetention';

// The only way this program creates a Lambda function: each one gets its own
// log group, owned by the stack and with the configured retention, so no
// function falls back to Lambda's auto-created group that never expires.
// guardrails.spec.ts fails for any function without one. See
// openspec/changes/archive/2026-11-14-set-lambda-log-retention/design.md (decisions 1-4).
export function createLambdaFunction(
  name: string,
  args: Omit<aws.lambda.FunctionArgs, 'loggingConfig'>,
  opts: pulumi.CustomResourceOptions,
): aws.lambda.Function {
  const retentionInDays = logRetentionDays(
    new pulumi.Config().get('logRetentionDays'),
  );

  // A fixed name, independent of the function's autonamed physical name, so the
  // group exists before the function can write and no import is needed. Only
  // the provider is passed on: the group never waits on the function's
  // dependencies (e.g. migrations).
  const logGroup = new aws.cloudwatch.LogGroup(
    name,
    {
      name: `/aws/lambda/draupnir/${pulumi.getStack()}/${name}`,
      retentionInDays,
    },
    { provider: opts.provider },
  );

  return new aws.lambda.Function(
    name,
    {
      ...args,
      // Plain text keeps today's output; the provider requires a format here.
      loggingConfig: { logFormat: 'Text', logGroup: logGroup.name },
    },
    opts,
  );
}
