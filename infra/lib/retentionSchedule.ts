// How often the bot-retention run happens. Every run resumes the paused Aurora
// cluster (aurora.ts), so the default is as sparse as the 48-hour guarantee
// allows. See openspec/changes/reduce-retention-schedule/design.md
// (decisions 1-3).

export const RETENTION_SCHEDULE_CONFIG_KEY = 'draupnir-infra:retentionSchedule';
export const DEFAULT_RETENTION_SCHEDULE = 'rate(12 hours)';

// Telegram refuses to delete a message older than this.
export const TELEGRAM_DELETE_LIMIT_HOURS = 48;
// A recorded message is due for deletion at this age. Must equal the interval
// in claim_due_bot_messages (shared/src/lib/migrations/0019-*.ts).
export const DELETE_AFTER_HOURS = 20;
// Headroom for the run's own duration (up to 10 minutes) and scheduling slack.
export const SAFETY_HOURS = 2;
// The schedule never retries a failed run, so a message may wait through two
// periods (one missed run) after it is due: 20 + 2 * 13 + 2 = 48.
export const MAX_RETENTION_PERIOD_HOURS =
  (TELEGRAM_DELETE_LIMIT_HOURS - DELETE_AFTER_HOURS - SAFETY_HOURS) / 2;

const HOURS_PER_UNIT: Record<string, number> = {
  minute: 1 / 60,
  hour: 1,
  day: 24,
};

// Returns the expression for EventBridge Scheduler, or throws if it could let a
// message reach 48 hours undeleted after one missed run. Only fixed rates are
// accepted: the longest gap of a cron or one-time expression cannot be checked.
export function retentionScheduleExpression(value: string): string {
  const match = /^rate\((\d+) (minute|hour|day)s?\)$/.exec(value.trim());
  const refuse = (why: string): never => {
    throw new Error(
      `${RETENTION_SCHEDULE_CONFIG_KEY} "${value}" ${why}; use rate(<n> minutes|hours) ` +
        `with a period of at most ${MAX_RETENTION_PERIOD_HOURS} hours`,
    );
  };
  if (!match) return refuse('is not a fixed rate');
  const count = Number(match[1]);
  const unit = match[2] as string;
  if (count < 1) return refuse('must be at least 1');
  const hours = count * (HOURS_PER_UNIT[unit] as number);
  if (hours > MAX_RETENTION_PERIOD_HOURS) {
    return refuse(`runs every ${hours} hours, too rarely`);
  }
  return value.trim();
}
