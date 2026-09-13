import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { authInfoFromClaims, mcpHandler } from './mcp';

function connectAsSub(sub: string) {
  const transport = new StreamableHTTPClientTransport(
    new URL('http://test.local/mcp'),
    {
      fetch: (url, init) =>
        mcpHandler.fetch(new Request(url, init), {
          authInfo: authInfoFromClaims({ sub }, 'test-token'),
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
