## Context

See proposal.md for motivation. The infrastructure is Pulumi (TypeScript), so the setting is `scalingConfig: { maximumConcurrency }` on `aws.lambda.EventSourceMapping` (supported in `@pulumi/aws` 7.43). Three mappings exist and none sets it:

| Mapping | Defined in | Queue | Function |
|---|---|---|---|
| `bot-updates` | `bot.ts` (loop) | `draupnir-bot-updates.fifo`, group = chat id | `bot-worker` |
| `bot-outcomes` | `bot.ts` (loop) | standard | `bot-worker` |
| `ingest` | `ingestionPipeline.ts` | standard (S3 notifications) | `ingest` |

Account quota (read 2026-11-13 with `aws lambda get-account-settings --region eu-north-1`): `ConcurrentExecutions` 10, `UnreservedConcurrentExecutions` 10, 13 functions. All functions share those 10 slots, so no more than 10 invocations are ever in flight. The quota is an AWS setting that can change (it may rise as the account ages or after a request); nothing in this repository pins it.

## Goals / Non-Goals

**Goals:**
- Stop a queue backlog from using all of the account's concurrency, so the API and the Cognito pre-sign-up trigger keep capacity.
- One shared constant for the number.

**Non-Goals:**
- Reserved concurrency on API-invoked functions, a gate setting, a quota check or an alarm (see proposal; dropped at this quota).
- Changing visibility timeouts, redrive counts or the worker timeout.
- Provisioned concurrency.

## Decisions

### 1. Cap at the mapping, not with reserved concurrency

With a reservation on a queue consumer the poller keeps receiving messages, the invocation is throttled, and the message returns to the queue with its receive count incremented; at `maxReceiveCount` (3 updates, 5 outcomes and ingest) it reaches the DLQ without ever failing. `maximumConcurrency` makes the poller stop pulling, so excess messages stay in the queue. A reservation is also impossible here: the quota (10) equals AWS's unreserved floor, so none can be set.

### 2. Value 2, per mapping, one constant

`QUEUE_MAX_CONCURRENCY = 2` in new `infra/lib/concurrencyLimits.ts` (2 is also SQS's minimum allowed value), used by all three mappings. The cap is per mapping, so `bot-worker` can run up to 4 invocations (2 updates + 2 outcomes) and the three consumers use at most 6 of the 10 slots, leaving 4. Alternative: also cap the worker at 4 in total with a reservation. Not possible at this quota, and it would bring back the throttle-and-retry problem above.

### 3. FIFO assumptions in `botQueues.ts`, re-checked

- *Ordering per chat.* FIFO SQS does not release a later message of a message group while an earlier one is in flight, and Lambda keeps that order. The group id is the chat id, so the cap changes how many chats run in parallel, never the order inside one chat. Effective concurrency on the updates queue is `min(distinct active chats, 2)`. The webhook only queues updates from allowlisted Telegram users (#67), so 1–2 chats is normal and the cap rarely binds.
- *`batchSize: 1` and `ReportBatchItemFailures`.* Unchanged. The worker's "report every later record as failed after the first failure" rule is moot with one record per batch and stays correct if the batch size is raised.
- *Visibility timeout 540 s vs worker timeout 90 s* (the 6× rule) and the *DLQ counts*. A capped mapping leaves waiting messages visible in the queue (not in flight), so waiting for a slot does not consume receive counts or let a visibility timeout expire. The 2-minute outcome-report lease (design decision 7 in `add-telegram-bot`) is still shorter than the visibility timeout, so a redelivery can't overlap a live claim.
- *Re-checked against the code at apply (2026-11-13):* the webhook sets `groupId: String(chat.id)` and `dedupId: String(update.update_id)`; `botQueues.ts` has visibility 90 × 6 = 540 s and redrive counts 3 (updates) and 5 (outcomes). No queue setting needed to change.
- *Head-of-line blocking.* A slow update (up to 90 s) holds one of two slots; a third active chat waits. Acceptable at this scale; raise the constant if the allowlist grows.

### 4. What happens when the account is saturated anyway

The cap leaves 4 slots but does not reserve them, and nothing limits the API functions individually, so a flood on a public route can still use all 10 and throttle everything, including `pre-sign-up-trigger`. Lambda answers a synchronous invoke at the limit with a 429; REST API Gateway with a proxy integration is reported to return **500** to the client (AWS re:Post and Knowledge Center logs: "Lambda invocation failed with status: 429 … Method completed with status: 500"). **Observed on the live stack on 2026-11-13** (task 4.3): with `bot-callback` temporarily at reserved concurrency 0, `GET /telegram/callback` returned `HTTP 500`, `x-amzn-errortype: InternalServerErrorException`, body `{"message": "Internal server error"}`; with the reservation removed it ran normally again. (`whoami` couldn't be used: it is behind the Cognito authorizer, which answers 401 before Lambda is reached.). Telegram retries a non-2xx webhook call (the FIFO dedup id `update_id` drops a duplicate); a throttled callback never ran, so the one-time link state is not consumed; MCP and ingestion callers get a retryable error, per the existing "retry once" contract for DB-backed routes; a throttled sign-up trigger shows the user a Cognito error and only affects a *first-time* sign-up (an existing user's sign-in does not invoke the trigger). The existing bot stage throttle (10 rps) and the Telegram allowlist are the mitigations on the API side. This is the accepted residual risk of not reserving; reserving needs a quota of at least 27 (17 across the seven API functions + 10 floor) and is deferred.

### 5. Documentation instead of enforcement

The ceiling is AWS's, so the repo records it rather than pinning it: `docs/architecture.md` states the quota, the date, the `aws lambda get-account-settings` command to re-check, and "if this changes, revisit the cap and the deferred reservations". No script or alarm enforces it (dropped as not worth the effort at this scale).

## Risks / Trade-offs

- [The 10-slot ceiling is AWS's setting and can change without any commit] → Documented with the date and re-check command; if it rises, the API side becomes uncapped per function and this design should be revisited (deferred reservations, 27 needed).
- [A public-route flood can still starve the API and sign-up of the remaining 4 slots] → Accepted; see decision 4.
- [Worker can run 4 invocations, not 2] → Documented in the spec; it is still a hard bound.
- [A third active chat waits behind two slow updates] → Acceptable for an allowlisted bot; raise the constant if needed.
- [Merge with `add-bot-ai-chat` in `bot.ts`] → Adjacent lines, trivial.

## Migration Plan

1. Add the constant and the three `scalingConfig` blocks; `infra:preview` shows only the three mappings updating in place.
2. `infra:up`; verify with `aws lambda get-event-source-mapping` (`ScalingConfig.MaximumConcurrency` 2).
3. Rollback: revert and `infra:up` (or `aws lambda update-event-source-mapping --scaling-config '{}'` for an immediate removal); nothing is stored or migrated.
