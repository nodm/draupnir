import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
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
