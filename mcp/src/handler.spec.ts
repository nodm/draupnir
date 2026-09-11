import type { APIGatewayProxyWithCognitoAuthorizerEvent } from 'aws-lambda';

const fetch = vi.fn().mockImplementation(
  async () =>
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
);
const authInfoForSub = vi.fn((sub: string) => ({
  token: sub,
  clientId: sub,
  scopes: [],
}));

vi.mock('./lib/mcp', () => ({
  mcpHandler: { fetch: (...args: unknown[]) => fetch(...args) },
  authInfoForSub: (sub: string) => authInfoForSub(sub),
}));

function cognitoEvent(
  overrides: Partial<APIGatewayProxyWithCognitoAuthorizerEvent> = {},
): APIGatewayProxyWithCognitoAuthorizerEvent {
  return {
    path: '/mcp',
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    isBase64Encoded: false,
    requestContext: {
      authorizer: { claims: { sub: 'user-123' } },
    },
    ...overrides,
  } as APIGatewayProxyWithCognitoAuthorizerEvent;
}

describe('mcp handler', () => {
  beforeEach(() => {
    fetch.mockClear();
    authInfoForSub.mockClear();
  });

  it('forwards an authenticated request and returns the fetch response as a proxy result', async () => {
    const { handler } = await import('./handler');

    const result = await handler(cognitoEvent(), {} as never, () => undefined);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(authInfoForSub).toHaveBeenCalledWith('user-123');
    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }),
    });
  });

  it('derives identity only from the claim, ignoring any identifier in the body', async () => {
    const { handler } = await import('./handler');

    await handler(
      cognitoEvent({
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: { sub: 'attacker-controlled', userId: 'someone-else' },
        }),
      }),
      {} as never,
      () => undefined,
    );

    expect(authInfoForSub).toHaveBeenCalledWith('user-123');
    expect(authInfoForSub).not.toHaveBeenCalledWith('attacker-controlled');
  });

  it('rejects a request whose authorizer claims carry no sub, without calling the MCP handler', async () => {
    const { handler } = await import('./handler');

    const result = await handler(
      cognitoEvent({ requestContext: { authorizer: { claims: {} } } } as never),
      {} as never,
      () => undefined,
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ statusCode: 401 });
  });
});
