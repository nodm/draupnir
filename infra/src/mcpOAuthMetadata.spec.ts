import {
  authorizationServerMetadata,
  protectedResourceMetadata,
} from '../lib/mcpOAuthMetadata';

const config = {
  origin: 'https://mcp.example.test',
  userPoolId: 'eu-north-1_POOL',
  region: 'eu-north-1',
};

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
    expect(m.scopes_supported).toEqual(['openid', 'email', 'profile']);
    expect(m).not.toHaveProperty(
      'authorization_response_iss_parameter_supported',
    );
  });

  // API Gateway evaluates the document as a mapping template, where `$` and
  // `#` start expressions; a later field containing either would break it.
  it.each([
    ['protected resource', protectedResourceMetadata(config)],
    ['authorization server', authorizationServerMetadata(config)],
  ])('%s document has no `$` or `#` for the mapping template', (_n, doc) => {
    expect(JSON.stringify(doc)).not.toMatch(/[$#]/);
  });
});
