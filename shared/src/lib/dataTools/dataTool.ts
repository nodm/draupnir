import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import { z } from 'zod';
import {
  executeStatement,
  withCaller,
  type DataApiConfig,
  type ExecuteResult,
  type SqlParameterValue,
} from '../dataApi';

export interface DbContext {
  client: RDSDataClient;
  config: DataApiConfig;
}

// `sub` is the caller's resolved identity; a surface that couldn't resolve one
// passes nothing and the tool refuses before touching the database.
export interface DataToolContext {
  sub: string | null | undefined;
  db: DbContext;
}

// What a handler gets: the caller and a query function bound to the caller's
// transaction (so RLS applies).
export interface DataToolQuery {
  sub: string;
  query(
    sql: string,
    parameters?: Record<string, SqlParameterValue>,
  ): Promise<ExecuteResult>;
}

// `unavailable`: the data is not ready yet (a backfill is still running).
export type DataToolErrorCode =
  | 'unauthenticated'
  | 'invalid_input'
  | 'unavailable';

// Expected, caller-fixable failures. Adapters show the message to the model or
// client; anything else is an unexpected fault.
export class DataToolError extends Error {
  constructor(
    readonly code: DataToolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DataToolError';
  }
}

// Provider-neutral definition: each AI surface (MCP, Claude API) adapts name,
// description and inputSchema to its own API and calls `run`.
export interface DataTool<O = unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(ctx: DataToolContext, input: unknown): Promise<O>;
}

export function defineDataTool<S extends z.ZodType, O>(definition: {
  name: string;
  description: string;
  input: S;
  handler: (q: DataToolQuery, input: z.output<S>) => Promise<O>;
}): DataTool<O> {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: z.toJSONSchema(definition.input, { io: 'input' }),
    async run(ctx, rawInput) {
      if (!ctx.sub) {
        throw new DataToolError(
          'unauthenticated',
          'No caller identity; the tool was not run',
        );
      }
      const parsed = definition.input.safeParse(rawInput ?? {});
      if (!parsed.success) {
        throw new DataToolError(
          'invalid_input',
          parsed.error.issues
            .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
            .join('; '),
        );
      }
      const sub = ctx.sub;
      const { client, config } = ctx.db;
      return withCaller(client, config, sub, (transactionId) =>
        definition.handler(
          {
            sub,
            query: (sql, parameters) =>
              executeStatement(client, config, sql, parameters, transactionId),
          },
          parsed.data,
        ),
      );
    },
  };
}

// Bank-provided text (descriptions) travels only under this key, so a surface
// can present it as external data and never as instructions.
export interface Untrusted<T> {
  untrusted: T;
}
