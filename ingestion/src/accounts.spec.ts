import type { APIGatewayProxyWithCognitoAuthorizerEvent } from 'aws-lambda';

const createAccount = vi.fn();

vi.mock('shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('shared')>()),
  createAccount: (...args: unknown[]) => createAccount(...args),
  loadDataApiConfigFromEnv: () => ({}),
}));

function event(
  claims: Record<string, string>,
): APIGatewayProxyWithCognitoAuthorizerEvent {
  return {
    body: '{}',
    requestContext: { authorizer: { claims } },
  } as unknown as APIGatewayProxyWithCognitoAuthorizerEvent;
}

describe('accounts handler', () => {
  beforeEach(() => createAccount.mockReset());

  it('returns 401 without calling createAccount when the caller has no sub claim', async () => {
    const { handler } = await import('./accounts');

    const result = await handler(event({}), {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 401 });
    expect(createAccount).not.toHaveBeenCalled();
  });

  it('creates the account as the sub from the claims', async () => {
    createAccount.mockResolvedValue({ id: 'a1' });
    const { handler } = await import('./accounts');

    const result = await handler(
      event({ sub: 'u1' }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 201 });
    expect(createAccount).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'u1',
      {},
    );
  });
});
