import type { APIGatewayProxyWithCognitoAuthorizerEvent } from 'aws-lambda';

const fetch = vi.fn().mockImplementation(
  async () =>
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
);
const authInfoFromClaims = vi.fn(
  (claims: { [name: string]: string }, token: string) => ({
    token,
    clientId: claims['aud'] ?? '',
    scopes: [],
    extra: { sub: claims['sub'] },
  }),
);

vi.mock('./lib/mcp', () => ({
  mcpHandler: { fetch: (...args: unknown[]) => fetch(...args) },
  authInfoFromClaims: (claims: { [name: string]: string }, token: string) =>
    authInfoFromClaims(claims, token),
}));

function cognitoEvent(
  overrides: Partial<APIGatewayProxyWithCognitoAuthorizerEvent> = {},
): APIGatewayProxyWithCognitoAuthorizerEvent {
  return {
    path: '/mcp',
    httpMethod: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer test-token',
    },
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
    authInfoFromClaims.mockClear();
  });

  it('forwards the API Gateway event as an equivalent Request and returns the fetch response as a proxy result', async () => {
    const { handler } = await import('./handler');

    const result = await handler(cognitoEvent(), {} as never, () => undefined);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [request] = fetch.mock.calls[0] as [Request, unknown];
    expect(request.method).toBe('POST');
    expect(request.headers.get('content-type')).toBe('application/json');
    await expect(request.text()).resolves.toBe(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    );

    expect(authInfoFromClaims).toHaveBeenCalledWith(
      { sub: 'user-123' },
      'test-token',
    );
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

    expect(authInfoFromClaims).toHaveBeenCalledWith(
      { sub: 'user-123' },
      'test-token',
    );
    expect(authInfoFromClaims).not.toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'attacker-controlled' }),
      expect.anything(),
    );
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
