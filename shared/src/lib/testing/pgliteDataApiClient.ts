import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import type { PGlite } from '@electric-sql/pglite';

// Test-only: an RDSDataClient stand-in backed by pglite, so SQL written for
// the Data API (named `:param` placeholders, typed parameters, transactions)
// is exercised against a real Postgres. pglite has one connection, so a Data
// API "transaction" is a plain BEGIN/COMMIT and the transaction id is a
// placeholder. Imports pglite as a type only; nothing here loads it at runtime.

interface FieldLike {
  stringValue?: string;
  doubleValue?: number;
  longValue?: number;
  booleanValue?: boolean;
  isNull?: boolean;
}

interface SqlParameterLike {
  name?: string;
  value?: FieldLike;
}

function fieldToValue(field: FieldLike | undefined): unknown {
  if (!field || field.isNull) return null;
  if (field.stringValue !== undefined) return field.stringValue;
  if (field.longValue !== undefined) return field.longValue;
  if (field.doubleValue !== undefined) return field.doubleValue;
  if (field.booleanValue !== undefined) return field.booleanValue;
  return null;
}

// `:name` -> `$n`, leaving `::cast` and string literals' colons alone.
export function toPositional(
  sql: string,
  parameters: readonly SqlParameterLike[],
): { text: string; values: unknown[] } {
  const byName = new Map(
    parameters.map((p) => [p.name as string, fieldToValue(p.value)]),
  );
  const order: string[] = [];
  const text = sql.replace(
    /(?<![:\w]):([A-Za-z_][A-Za-z0-9_]*)/g,
    (_match, name: string) => {
      if (!byName.has(name)) {
        throw new Error(`Missing SQL parameter :${name}`);
      }
      let index = order.indexOf(name);
      if (index === -1) {
        order.push(name);
        index = order.length - 1;
      }
      return `$${index + 1}`;
    },
  );
  return { text, values: order.map((name) => byName.get(name)) };
}

// Match what Data API's JSON record format returns: dates as 'YYYY-MM-DD'
// strings and int8/numeric as JSON numbers (pglite would give Date / BigInt).
const PARSERS = {
  1082: (value: string) => value,
  20: (value: string) => Number(value),
  1700: (value: string) => Number(value),
};

export interface PgliteDataApiClient {
  client: RDSDataClient;
  // Names of the Data API commands sent, in order — for asserting call shape.
  commands: string[];
}

export function createPgliteDataApiClient(db: PGlite): PgliteDataApiClient {
  const commands: string[] = [];

  const send = async (command: unknown): Promise<unknown> => {
    const name = (command as { constructor: { name: string } }).constructor
      .name;
    commands.push(name);
    const input = (command as { input: Record<string, unknown> }).input;

    switch (name) {
      case 'BeginTransactionCommand':
        await db.exec('BEGIN');
        return { transactionId: 'pglite-tx' };
      case 'CommitTransactionCommand':
        await db.exec('COMMIT');
        return {};
      case 'RollbackTransactionCommand':
        await db.exec('ROLLBACK');
        return {};
      case 'ExecuteStatementCommand': {
        const { text, values } = toPositional(
          input['sql'] as string,
          (input['parameters'] as SqlParameterLike[] | undefined) ?? [],
        );
        const result = await db.query<Record<string, unknown>>(text, values, {
          parsers: PARSERS,
        });
        return {
          formattedRecords: JSON.stringify(result.rows),
          numberOfRecordsUpdated: result.affectedRows ?? 0,
        };
      }
      case 'BatchExecuteStatementCommand': {
        for (const set of input['parameterSets'] as SqlParameterLike[][]) {
          const { text, values } = toPositional(input['sql'] as string, set);
          await db.query(text, values);
        }
        return { updateResults: [] };
      }
      default:
        throw new Error(`Unsupported Data API command: ${name}`);
    }
  };

  return { client: { send } as unknown as RDSDataClient, commands };
}
