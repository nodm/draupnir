import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { PGlite } from '@electric-sql/pglite';
import { applyMigrationsForTest, createPgliteDataApiClient } from 'shared';
import { DATA_TOOLS, DataToolError, type DataTool } from 'shared/dataTools';
import {
  authInfoFromClaims,
  createHandler,
  mcpHandler,
  resolveCallerSub,
} from './mcp';

function connectAsSub(sub: string | undefined, handler = mcpHandler) {
  const transport = new StreamableHTTPClientTransport(
    new URL('http://test.local/mcp'),
    {
      fetch: (url, init) =>
        handler.fetch(new Request(url, init), {
          authInfo: authInfoFromClaims(
            sub === undefined ? {} : { sub },
            'test-token',
          ),
        }),
    },
  );
  const client = new Client({ name: 'test-harness', version: '1.0.0' });
  return { client, connect: () => client.connect(transport) };
}

describe('mcpHandler', () => {
  it('responds to a well-formed JSON-RPC request with a correlated response, reflecting the caller sub', async () => {
    const { client, connect } = connectAsSub('user-123');
    await connect();

    const result = await client.callTool({ name: 'whoami', arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: 'text', text: 'user-123' }]);
  });

  it('ignores a body-supplied identifier, still reflecting only the injected sub', async () => {
    const { client, connect } = connectAsSub('user-123');
    await connect();

    const result = await client.callTool({
      name: 'whoami',
      arguments: { sub: 'attacker-controlled' },
    });

    expect(result.content).toEqual([{ type: 'text', text: 'user-123' }]);
  });

  it('returns a JSON-RPC error response for a malformed request body rather than throwing', async () => {
    const response = await mcpHandler.fetch(
      new Request('http://test.local/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: 'not json',
      }),
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    const body = await response.json();
    expect(body).toMatchObject({ jsonrpc: '2.0', error: expect.any(Object) });
  });
});

describe('resolveCallerSub', () => {
  it('returns the sub claim when present', () => {
    expect(resolveCallerSub(authInfoFromClaims({ sub: 'u1' }, 't'))).toBe('u1');
  });

  it('returns undefined when the claim is absent or empty', () => {
    expect(resolveCallerSub(authInfoFromClaims({}, 't'))).toBeUndefined();
    expect(
      resolveCallerSub(authInfoFromClaims({ sub: '' }, 't')),
    ).toBeUndefined();
    expect(resolveCallerSub(undefined)).toBeUndefined();
  });
});

describe('data tools over MCP', () => {
  const run = vi.fn();
  const getDb = vi.fn(() => ({ client: {}, config: {} }) as never);
  const fakeTool: DataTool = {
    name: 'fake_tool',
    description: 'a fake',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
    run,
  };
  const handler = createHandler({ tools: [fakeTool], getDb });

  beforeEach(() => {
    run.mockReset();
    getDb.mockClear();
  });

  it('lists whoami and every shared tool with its schema', async () => {
    const { client, connect } = connectAsSub(
      'u1',
      createHandler({ tools: DATA_TOOLS, getDb }),
    );
    await connect();

    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual(
      ['whoami', ...DATA_TOOLS.map((t) => t.name)].sort(),
    );
    for (const tool of DATA_TOOLS) {
      expect(
        tools.find((t) => t.name === tool.name)?.inputSchema,
      ).toMatchObject(tool.inputSchema);
    }
  });

  it('runs the shared tool as the injected sub and returns its result', async () => {
    run.mockResolvedValue({ transactions: [], nextCursor: 'c1' });
    const { client, connect } = connectAsSub('u1', handler);
    await connect();

    const result = await client.callTool({
      name: 'fake_tool',
      arguments: { limit: 5 },
    });

    expect(run).toHaveBeenCalledWith(
      { sub: 'u1', db: getDb.mock.results[0].value },
      { limit: 5 },
    );
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      transactions: [],
      nextCursor: 'c1',
    });
    expect(result.content).toEqual([
      {
        type: 'text',
        text: JSON.stringify({ transactions: [], nextCursor: 'c1' }),
      },
    ]);
  });

  it('returns array results as JSON text', async () => {
    run.mockResolvedValue([{ id: 'A1' }]);
    const { client, connect } = connectAsSub('u1', handler);
    await connect();

    const result = await client.callTool({ name: 'fake_tool', arguments: {} });

    expect(result.content).toEqual([{ type: 'text', text: '[{"id":"A1"}]' }]);
  });

  it('ignores a body-supplied sub for authorization', async () => {
    run.mockResolvedValue({});
    const { client, connect } = connectAsSub('u1', handler);
    await connect();

    await client.callTool({
      name: 'fake_tool',
      arguments: { sub: 'attacker' },
    });

    expect(run.mock.calls[0][0].sub).toBe('u1');
  });

  it('maps a shared tool error to a tool error carrying its message', async () => {
    run.mockRejectedValue(new DataToolError('invalid_input', 'limit: too big'));
    const { client, connect } = connectAsSub('u1', handler);
    await connect();

    const result = await client.callTool({
      name: 'fake_tool',
      arguments: { limit: 999 },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'limit: too big' }]);
  });

  it('hides unexpected fault details', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    run.mockRejectedValue(new Error('secret arn leaked'));
    const { client, connect } = connectAsSub('u1', handler);
    await connect();

    const result = await client.callTool({ name: 'fake_tool', arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'Internal error' }]);
  });

  it('refuses without a sub and never runs the tool or touches the db', async () => {
    const { client, connect } = connectAsSub(undefined, handler);
    await connect();

    const result = await client.callTool({ name: 'fake_tool', arguments: {} });

    expect(result.isError).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(getDb).not.toHaveBeenCalled();
  });
});

describe('real shared tools over MCP (pglite, RLS as draupnir_app)', () => {
  let pg: PGlite;
  let handler: ReturnType<typeof createHandler>;

  beforeAll(async () => {
    pg = new PGlite();
    await applyMigrationsForTest(pg);
    await pg.exec(`
      INSERT INTO accounts (id, bank, iban, currency, display_name, opened_on, opening_balance_minor_units) VALUES
        ('A1', 'seb', 'LT000000000000001111', 'EUR', 'Alice main', '2026-01-01', 0),
        ('A2', 'seb', 'LT000000000000002222', 'EUR', 'Carol shared', '2026-01-01', 0),
        ('A3', 'seb', 'LT000000000000003333', 'EUR', 'Carol private', '2026-01-01', 0);
      INSERT INTO account_members (account_id, user_id, role) VALUES
        ('A1', 'alice', 'owner'), ('A2', 'carol', 'owner'),
        ('A2', 'alice', 'viewer'), ('A3', 'carol', 'owner');
      INSERT INTO transactions (id, account_id, posted_date, amount_minor_units, currency, description, dedup_key) VALUES
        ('a1-1', 'A1', '2026-01-01', -1, 'EUR', 'mine', 'a1-1'),
        ('a2-1', 'A2', '2026-01-02', -2, 'EUR', 'shared', 'a2-1'),
        ('a2-2', 'A2', '2026-01-03', -3, 'EUR', 'shared 2', 'a2-2'),
        ('a3-1', 'A3', '2026-01-04', -4, 'EUR', 'carol private', 'a3-1');
    `);
    const { client } = createPgliteDataApiClient(pg, { role: 'draupnir_app' });
    handler = createHandler({
      tools: DATA_TOOLS,
      getDb: () => ({
        client,
        config: { resourceArn: 'a', secretArn: 'a', database: 'd' },
      }),
    });
    // PGlite startup plus migrations exceeds the 10 s default when the
    // workspace's other test suites run in parallel.
  }, 60_000);
  afterAll(async () => {
    await pg.close();
  });

  async function call(
    sub: string,
    name: string,
    args: Record<string, unknown> = {},
  ) {
    const { client, connect } = connectAsSub(sub, handler);
    await connect();
    return client.callTool({ name, arguments: args });
  }

  it('list_accounts returns the array result, with the viewer role and nothing else', async () => {
    const result = await call('alice', 'list_accounts');

    const accounts = JSON.parse((result.content as { text: string }[])[0].text);
    expect(
      accounts.map((a: { id: string; role: string }) => [a.id, a.role]).sort(),
    ).toEqual([
      ['A1', 'owner'],
      ['A2', 'viewer'],
    ]);
  });

  it('list_transactions shows the viewer only visible rows, and nothing for an unseen account', async () => {
    const all = await call('alice', 'list_transactions', { limit: 200 });
    const ids = (
      all.structuredContent as { transactions: { id: string }[] }
    ).transactions.map((t) => t.id);
    expect(ids.sort()).toEqual(['a1-1', 'a2-1', 'a2-2']);

    const hidden = await call('alice', 'list_transactions', {
      accountId: 'A3',
    });
    expect(
      (hidden.structuredContent as { transactions: unknown[] }).transactions,
    ).toEqual([]);
  });

  it('list_transactions pages round-trip through MCP without duplicates', async () => {
    const first = await call('alice', 'list_transactions', { limit: 2 });
    const p1 = first.structuredContent as {
      transactions: { id: string }[];
      nextCursor?: string;
    };
    expect(p1.nextCursor).toBeDefined();
    const second = await call('alice', 'list_transactions', {
      limit: 2,
      cursor: p1.nextCursor,
    });
    const p2 = second.structuredContent as {
      transactions: { id: string }[];
      nextCursor?: string;
    };

    expect(
      [...p1.transactions, ...p2.transactions].map((t) => t.id).sort(),
    ).toEqual(['a1-1', 'a2-1', 'a2-2']);
    expect(p2.nextCursor).toBeUndefined();
  });

  it('returns the shared validation error as a tool error', async () => {
    const result = await call('alice', 'list_transactions', { limit: 100000 });

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toMatch(/limit/);
  });
});
