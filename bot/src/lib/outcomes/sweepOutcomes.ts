import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import type { SQSClient } from '@aws-sdk/client-sqs';
import {
  publishDueOutcomes,
  republishUnreportedOutcomes,
  type DataApiConfig,
} from 'shared';

// Outcomes that never reached the queue, then outcomes the queue gave up on.
// Each is logged on failure and never thrown: callers run this beside other
// work (the retention sweep, a batch of updates) that must not fail because of
// it. Run by the scheduled retention run and, while Aurora is awake anyway, by
// the worker after user traffic (design.md decision 6).
export async function sweepOutcomes(
  client: RDSDataClient,
  config: DataApiConfig,
  sqs: SQSClient,
  queueUrl: string,
): Promise<void> {
  for (const [event, sweep] of [
    ['outcome-sweep-failed', publishDueOutcomes],
    ['outcome-reconcile-failed', republishUnreportedOutcomes],
  ] as const) {
    await sweep(client, config, sqs, queueUrl).catch((error: unknown) =>
      console.error(
        JSON.stringify({
          event,
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
  }
}
