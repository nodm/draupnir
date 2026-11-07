import type { APIGatewayProxyEvent } from 'aws-lambda';
import { createOAuthHandler } from './oauth';

const config = {
  origin: 'https://mcp.example.test',
  cognitoDomainUrl: 'https://auth.example.test',
  userPoolId: 'pool',
  region: 'eu-north-1',
};
const send = vi.fn();
const fetchMock = vi.fn();
const handler = createOAuthHandler({
  config: () => config,
  cognito: () => ({ send }),
  fetch: fetchMock,
});

function event(
  method: string,
  resource: string,
  body?: string,
  isBase64Encoded = false,
) {
  return {
    httpMethod: method,
    resource,
    body: body ?? null,
    isBase64Encoded,
  } as APIGatewayProxyEvent;
}
const call = (e: APIGatewayProxyEvent) =>
  handler(e, {} as never, () => undefined) as Promise<{
    statusCode: number;
    headers: Record<string, string>;
    body: string;
  }>;

describe('oauth handler routes', () => {
  beforeEach(() => {
    send.mockReset();
    fetchMock.mockReset();
  });

  it('GET /authorize redirects to Cognito without resource', async () => {
    const res = (await handler(
      {
        httpMethod: 'GET',
        resource: '/authorize',
        multiValueQueryStringParameters: {
          client_id: ['c1'],
          redirect_uri: ['http://localhost:1/cb'],
          resource: ['https://mcp.example.test/mcp'],
          state: ['s'],
        },
      } as unknown as APIGatewayProxyEvent,
      {} as never,
      () => undefined,
    )) as { statusCode: number; headers: Record<string, string> };
    expect(res.statusCode).toBe(302);
    const loc = new URL(res.headers['location']);
    expect(loc.origin + loc.pathname).toBe(
      'https://auth.example.test/oauth2/authorize',
    );
    expect(loc.searchParams.has('resource')).toBe(false);
    expect(loc.searchParams.get('client_id')).toBe('c1');
    expect(loc.searchParams.get('redirect_uri')).toBe('http://localhost:1/cb');
    expect(loc.searchParams.get('state')).toBe('s');
  });

  it('POST /token strips resource and forwards the rest to Cognito', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      text: async () =>
        '{"access_token":"a","id_token":"i","refresh_token":"r"}',
      headers: { get: () => 'application/json' },
    });
    const res = await call(
      event(
        'POST',
        '/token',
        'grant_type=authorization_code&code=c&code_verifier=v&client_id=x&resource=https%3A%2F%2Fmcp.example.test%2Fmcp',
      ),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      access_token: 'a',
      refresh_token: 'r',
    });
    expect(res.headers['cache-control']).toBe('no-store');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://auth.example.test/oauth2/token');
    const sent = new URLSearchParams(init.body);
    expect(sent.has('resource')).toBe(false);
    expect(sent.get('code')).toBe('c');
    expect(sent.get('code_verifier')).toBe('v');
  });

  it('POST /token relays Cognito errors unchanged', async () => {
    fetchMock.mockResolvedValue({
      status: 400,
      text: async () => '{"error":"invalid_grant"}',
      headers: { get: () => 'application/json' },
    });
    const res = await call(
      event('POST', '/token', 'grant_type=refresh_token&refresh_token=r'),
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toBe('{"error":"invalid_grant"}');
  });

  it('POST /token rejects other grant types without calling Cognito', async () => {
    const res = await call(
      event('POST', '/token', 'grant_type=client_credentials'),
    );
    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
  ])('serves protected resource metadata at %s', async (resource) => {
    const res = await call(event('GET', resource));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json');
    expect(JSON.parse(res.body)).toMatchObject({
      resource: 'https://mcp.example.test/mcp',
    });
  });

  it.each([
    '/.well-known/oauth-authorization-server',
    '/.well-known/openid-configuration',
  ])('serves authorization server metadata at %s', async (resource) => {
    const res = await call(event('GET', resource));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      issuer: 'https://mcp.example.test',
      registration_endpoint: 'https://mcp.example.test/register',
    });
  });

  it('registers a client from a JSON body, including a base64 body', async () => {
    send.mockImplementation((c: { constructor: { name: string } }) => {
      return Promise.resolve(
        c.constructor.name === 'ListUserPoolClientsCommand'
          ? { UserPoolClients: [] }
          : c.constructor.name === 'CreateUserPoolClientCommand'
            ? { UserPoolClient: { ClientId: 'cid' } }
            : {},
      );
    });
    const payload = JSON.stringify({
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    });

    const plain = await call(event('POST', '/register', payload));
    const b64 = await call(
      event('POST', '/register', Buffer.from(payload).toString('base64'), true),
    );

    expect(plain.statusCode).toBe(201);
    expect(JSON.parse(plain.body).client_id).toBe('cid');
    expect(plain.headers['cache-control']).toBe('no-store');
    expect(b64.statusCode).toBe(201);
  });

  it('answers 400 for an unparseable body without calling Cognito', async () => {
    const res = await call(event('POST', '/register', 'not json'));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_client_metadata');
    expect(send).not.toHaveBeenCalled();
  });

  it('answers 404 for any other route', async () => {
    expect((await call(event('GET', '/register'))).statusCode).toBe(404);
    expect((await call(event('GET', '/nope'))).statusCode).toBe(404);
  });
});
