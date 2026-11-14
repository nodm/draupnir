// How long every Lambda function's CloudWatch log group keeps events. Without
// a managed group, Lambda's auto-created one never expires. See
// openspec/changes/archive/2026-11-14-set-lambda-log-retention/design.md (decisions 1-3).

export const LOG_RETENTION_CONFIG_KEY = 'draupnir-infra:logRetentionDays';
export const DEFAULT_LOG_RETENTION_DAYS = 30;

// The only periods CloudWatch Logs accepts. 0 ("Never expire") is left out on
// purpose: it is the problem this guardrail removes.
export const ACCEPTED_LOG_RETENTION_DAYS = [
  1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827,
  2192, 2557, 2922, 3288, 3653,
] as const;

// Returns the retention in days, or throws so that `pulumi preview` fails
// before an `up` could fail halfway on CloudWatch's own validation.
export function logRetentionDays(value: string | undefined): number {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_LOG_RETENTION_DAYS;
  }
  const days = Number(value.trim());
  if (!(ACCEPTED_LOG_RETENTION_DAYS as readonly number[]).includes(days)) {
    throw new Error(
      `${LOG_RETENTION_CONFIG_KEY} "${value}" is not a retention period ` +
        `CloudWatch Logs accepts; use one of ${ACCEPTED_LOG_RETENTION_DAYS.join(', ')}`,
    );
  }
  return days;
}
