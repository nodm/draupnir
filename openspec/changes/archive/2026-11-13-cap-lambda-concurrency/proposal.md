## Why

The Lambda quota of this account is 10 concurrent executions in total (read 2026-11-13: `ConcurrentExecutions` 10, `UnreservedConcurrentExecutions` 10), which is also AWS's minimum unreserved floor, so per-function reservations are impossible and not worth a quota increase: the 10 is already a hard ceiling on concurrency and therefore on spend for a one-to-few-user system. What is still unbounded is how much of that 10 the two queue consumers can take. A backlog on the Telegram or statement queues can occupy every slot and starve the API functions and the Cognito pre-sign-up trigger.

## What Changes

- Cap the three SQS event source mappings at `scalingConfig.maximumConcurrency: 2`: `ingest`, and `bot-worker`'s two mappings (updates and outcomes). The queue consumers then use at most 6 of the 10 slots and 4 stay for everything else.
- One shared constant for the number, in `infra/lib/concurrencyLimits.ts`.
- Re-check the FIFO ordering assumptions in `botQueues.ts` under the cap (done in design.md; nothing needs to change).
- Document the account ceiling, where it comes from and that it is AWS's setting, not ours, in `docs/architecture.md`.
- New cross-cutting capability `cost-guardrails` records the cap and the documented ceiling.

**Deliberately not done** (considered and dropped as not worth the effort at a quota of 10; revisit only if the quota is raised):
- Reserved concurrency on the API-invoked functions (`mcp-oauth` 3, `mcp` 3, `bot-webhook` 3, `bot-callback` 2, `whoami`/`accounts`/`presigned-upload` 2 each; needs a quota of at least 27).
- A stack setting to switch reservations on or off, a pre-deploy quota check, and a CloudWatch alarm.
- A quota-increase request. Raising the quota removes the ceiling this change relies on, so request it only if the 10 proves too small in practice.
- Provisioned concurrency (a non-goal: it costs money while idle).

## Capabilities

### New Capabilities
- `cost-guardrails`: the queue consumers' concurrency cap and the recorded account-level concurrency ceiling.

### Modified Capabilities
(none)

## Impact

- `infra/lib/concurrencyLimits.ts` (new), `infra/lib/bot.ts` (two mappings), `infra/lib/ingestionPipeline.ts` (one mapping); offline mock specs assert the cap.
- `docs/architecture.md`.
- AWS: updates three event source mappings in place; no function is replaced. Under normal load nothing changes for users.
- Touches `infra/lib/bot.ts` next to the in-flight `add-bot-ai-chat` change (worker timeout and memory); the two are independent.
