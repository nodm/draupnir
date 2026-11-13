// Maximum concurrent invocations per SQS event source mapping. The cap is per
// mapping, so `bot-worker` (two mappings) can run up to 4 at once and the three
// queue consumers together use at most 6 of the account's concurrent executions,
// leaving the rest for the API and the Cognito pre-sign-up trigger. 2 is also
// the lowest value SQS accepts. Set on the mapping, not as reserved
// concurrency, so a message is never received and then throttled. See
// openspec/changes/archive/2026-11-13-cap-lambda-concurrency/design.md
// (decisions 1–2); the account quota behind it is in docs/architecture.md.
export const QUEUE_MAX_CONCURRENCY = 2;
