import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import { executeStatement, withCaller, type DataApiConfig } from 'shared';

// One guided dialogue per user (bot_conversations is keyed by user_id), kept
// for an hour since the user's last answer.
export const CONVERSATION_TTL_MS = 60 * 60 * 1000;

export interface Conversation<S> {
  kind: string;
  state: S;
}

export interface ConversationStore {
  get<S>(now?: Date): Promise<Conversation<S> | null>;
  set<S>(kind: string, state: S, now?: Date): Promise<void>;
  clear(): Promise<boolean>;
}

export function createConversationStore(
  client: RDSDataClient,
  config: DataApiConfig,
  sub: string,
): ConversationStore {
  const inCaller = <T>(fn: (tx: string) => Promise<T>) =>
    withCaller(client, config, sub, fn);

  return {
    // An expired dialogue reads as none.
    get: (now = new Date()) =>
      inCaller(async (tx) => {
        const { rows } = await executeStatement(
          client,
          config,
          `SELECT kind, CAST(state AS text) AS state FROM bot_conversations
            WHERE user_id = :sub AND expires_at > CAST(:now AS timestamptz)`,
          { sub, now: now.toISOString() },
          tx,
        );
        const row = rows[0] as { kind: string; state: string } | undefined;
        return row ? { kind: row.kind, state: JSON.parse(row.state) } : null;
      }),

    set: (kind, state, now = new Date()) =>
      inCaller(async (tx) => {
        await executeStatement(
          client,
          config,
          `INSERT INTO bot_conversations (user_id, kind, state, expires_at)
           VALUES (:sub, :kind, CAST(:state AS jsonb), CAST(:expiresAt AS timestamptz))
           ON CONFLICT (user_id) DO UPDATE
             SET kind = EXCLUDED.kind, state = EXCLUDED.state, expires_at = EXCLUDED.expires_at`,
          {
            sub,
            kind,
            state: JSON.stringify(state),
            expiresAt: new Date(
              now.getTime() + CONVERSATION_TTL_MS,
            ).toISOString(),
          },
          tx,
        );
      }),

    // True when there was a dialogue to abandon.
    clear: () =>
      inCaller(async (tx) => {
        const { numberOfRecordsUpdated } = await executeStatement(
          client,
          config,
          `DELETE FROM bot_conversations WHERE user_id = :sub`,
          { sub },
          tx,
        );
        return numberOfRecordsUpdated > 0;
      }),
  };
}
