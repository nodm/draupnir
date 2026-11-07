import {
  CLIENT_NAME_PREFIX,
  MAX_CLIENTS,
  authorizationServerMetadata,
  clientNameFor,
  protectedResourceMetadata,
  registerClient,
  validateRedirectUris,
  type CognitoLike,
  type OAuthConfig,
} from './oauth';

const config: OAuthConfig = {
  origin: 'https://mcp.example.test',
  cognitoDomainUrl: 'https://auth.example.test',
  userPoolId: 'eu-north-1_POOL',
  region: 'eu-north-1',
};

const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';
const LOOPBACK = 'http://127.0.0.1:53682/callback';

class FakeCognito implements CognitoLike {
  clients: { id: string; name: string }[] = [];
  commands: { name: string; input: Record<string, unknown> }[] = [];
  failBranding = false;

  send(command: unknown): Promise<unknown> {
    const c = command as {
      constructor: { name: string };
      input: Record<string, unknown>;
    };
    this.commands.push({ name: c.constructor.name, input: c.input });
    switch (c.constructor.name) {
      case 'ListUserPoolClientsCommand':
        return Promise.resolve({
          UserPoolClients: this.clients.map((x) => ({
            ClientId: x.id,
            ClientName: x.name,
          })),
        });
      case 'CreateUserPoolClientCommand': {
        const id = `client-${this.clients.length + 1}`;
        this.clients.push({ id, name: c.input['ClientName'] as string });
        return Promise.resolve({ UserPoolClient: { ClientId: id } });
      }
      case 'CreateManagedLoginBrandingCommand':
        return this.failBranding
          ? Promise.reject(new Error('branding failed'))
          : Promise.resolve({});
      case 'DeleteUserPoolClientCommand':
        this.clients = this.clients.filter((x) => x.id !== c.input['ClientId']);
        return Promise.resolve({});
      default:
        return Promise.reject(new Error(`unexpected ${c.constructor.name}`));
    }
  }
  count(name: string) {
    return this.commands.filter((x) => x.name === name).length;
  }
}

describe('metadata', () => {
  it('protected resource names the MCP endpoint and the origin as authorization server', () => {
    expect(protectedResourceMetadata(config)).toMatchObject({
      resource: 'https://mcp.example.test/mcp',
      authorization_servers: ['https://mcp.example.test'],
    });
  });

  it('authorization server metadata points at Cognito, S256, public clients and /register', () => {
    const m = authorizationServerMetadata(config);
    expect(m.issuer).toBe('https://mcp.example.test');
    expect(m.authorization_endpoint).toBe('https://mcp.example.test/authorize');
    expect(m.token_endpoint).toBe('https://mcp.example.test/token');
    expect(m.jwks_uri).toBe(
      'https://cognito-idp.eu-north-1.amazonaws.com/eu-north-1_POOL/.well-known/jwks.json',
    );
    expect(m.registration_endpoint).toBe('https://mcp.example.test/register');
    expect(m.code_challenge_methods_supported).toEqual(['S256']);
    expect(m.token_endpoint_auth_methods_supported).toEqual(['none']);
    expect(m).not.toHaveProperty(
      'authorization_response_iss_parameter_supported',
    );
  });
});

describe('validateRedirectUris', () => {
  it.each([
    [CLAUDE],
    ['https://claude.com/api/mcp/auth_callback'],
    [LOOPBACK],
    ['http://localhost:8080/oauth/callback'],
  ])('allows %s', (uri) => {
    expect(validateRedirectUris([uri])).toEqual({ ok: true, uris: [uri] });
  });

  it.each([
    ['another https host', 'https://evil.example/api/mcp/auth_callback'],
    ['claude path variant', 'https://claude.ai/api/mcp/other'],
    ['http non-loopback', 'http://example.com:8080/callback'],
    ['loopback without a port', 'http://localhost/callback'],
    ['https loopback', 'https://localhost:8080/callback'],
    ['query string', 'http://localhost:8080/callback?x=1'],
    ['fragment', 'http://localhost:8080/callback#x'],
    ['userinfo', 'http://user@localhost:8080/callback'],
    ['host with suffix', 'http://localhost.evil.example:8080/callback'],
    ['not a URL', 'not a url'],
    ['custom scheme', 'myapp://callback'],
  ])('refuses %s', (_label, uri) => {
    expect(validateRedirectUris([uri])).toMatchObject({
      ok: false,
      error: 'invalid_redirect_uri',
    });
  });

  it.each([[undefined], [[]], ['x'], [[1]], [[CLAUDE, 5]]])(
    'refuses %j',
    (value) => {
      expect(validateRedirectUris(value)).toMatchObject({ ok: false });
    },
  );

  it('refuses more than five URIs and dedupes before counting', () => {
    const six = Array.from(
      { length: 6 },
      (_, i) => `http://localhost:${8000 + i}/cb`,
    );
    expect(validateRedirectUris(six)).toMatchObject({ ok: false });
    expect(validateRedirectUris([CLAUDE, CLAUDE])).toEqual({
      ok: true,
      uris: [CLAUDE],
    });
  });

  it('sorts so the same set always names the same client', () => {
    const a = validateRedirectUris([LOOPBACK, CLAUDE]);
    const b = validateRedirectUris([CLAUDE, LOOPBACK]);
    expect(a).toEqual(b);
    expect(clientNameFor((a as { uris: string[] }).uris)).toMatch(
      new RegExp(`^${CLIENT_NAME_PREFIX}[0-9a-f]{16}$`),
    );
  });
});

describe('registerClient', () => {
  it('creates a public Google-only client with the requested callbacks and no secret', async () => {
    const cognito = new FakeCognito();

    const result = await registerClient(cognito, config, {
      redirect_uris: [CLAUDE],
    });

    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({
      client_id: 'client-1',
      redirect_uris: [CLAUDE],
      token_endpoint_auth_method: 'none',
    });
    expect(result.body).not.toHaveProperty('client_secret');
    const create = cognito.commands.find(
      (c) => c.name === 'CreateUserPoolClientCommand',
    );
    expect(create?.input).toMatchObject({
      UserPoolId: 'eu-north-1_POOL',
      GenerateSecret: false,
      AllowedOAuthFlows: ['code'],
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthScopes: ['openid', 'email', 'profile'],
      CallbackURLs: [CLAUDE],
      SupportedIdentityProviders: ['Google'],
      ExplicitAuthFlows: ['ALLOW_REFRESH_TOKEN_AUTH'],
    });
    expect(String(create?.input['ClientName'])).toMatch(/^mcp-dcr-/);
    expect(cognito.count('CreateManagedLoginBrandingCommand')).toBe(1);
  });

  it('reuses the client for the same redirect URIs', async () => {
    const cognito = new FakeCognito();

    const first = await registerClient(cognito, config, {
      redirect_uris: [CLAUDE, LOOPBACK],
    });
    const second = await registerClient(cognito, config, {
      redirect_uris: [LOOPBACK, CLAUDE],
    });

    expect(second.body['client_id']).toBe(first.body['client_id']);
    expect(cognito.count('CreateUserPoolClientCommand')).toBe(1);
  });

  it('creates nothing for a disallowed redirect URI', async () => {
    const cognito = new FakeCognito();

    const result = await registerClient(cognito, config, {
      redirect_uris: ['https://evil.example/cb'],
    });

    expect(result.status).toBe(400);
    expect(result.body['error']).toBe('invalid_redirect_uri');
    expect(cognito.commands).toEqual([]);
  });

  it('treats a non-object body as missing redirect_uris', async () => {
    const result = await registerClient(new FakeCognito(), config, undefined);
    expect(result.status).toBe(400);
  });

  describe('at the client cap', () => {
    function fullCognito() {
      const cognito = new FakeCognito();
      cognito.clients = Array.from({ length: MAX_CLIENTS }, (_, i) => ({
        id: `old-${i}`,
        name: `${CLIENT_NAME_PREFIX}${String(i).padStart(16, '0')}`,
      }));
      return cognito;
    }

    it('refuses a new set and creates nothing', async () => {
      const cognito = fullCognito();

      const result = await registerClient(cognito, config, {
        redirect_uris: [CLAUDE],
      });

      expect(result.status).toBe(429);
      expect(cognito.count('CreateUserPoolClientCommand')).toBe(0);
    });

    it('still returns a known set', async () => {
      const cognito = fullCognito();
      cognito.clients[0].name = clientNameFor([CLAUDE]);

      const result = await registerClient(cognito, config, {
        redirect_uris: [CLAUDE],
      });

      expect(result.status).toBe(201);
      expect(result.body['client_id']).toBe('old-0');
    });

    it('does not count clients it did not create', async () => {
      const cognito = fullCognito();
      cognito.clients = cognito.clients.map((c, i) => ({
        ...c,
        name: `app-${i}`,
      }));

      const result = await registerClient(cognito, config, {
        redirect_uris: [CLAUDE],
      });

      expect(result.status).toBe(201);
    });
  });

  it('deletes the new client and rethrows when branding fails', async () => {
    const cognito = new FakeCognito();
    cognito.failBranding = true;

    await expect(
      registerClient(cognito, config, { redirect_uris: [CLAUDE] }),
    ).rejects.toThrow('branding failed');

    expect(cognito.clients).toEqual([]);
  });
});
