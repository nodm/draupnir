// The OAuth discovery documents of the MCP origin. API Gateway serves them as
// fixed content built at deploy time (mcpApi.ts), so no function runs for a
// discovery request.

export interface OAuthMetadataConfig {
  // The MCP origin, e.g. https://mcp.draupnir.nodm.name (no trailing slash).
  origin: string;
  userPoolId: string;
  region: string;
}

// Mirrors SCOPES in mcp/src/lib/oauth.ts, which registration grants to the
// clients it creates. Change both together.
const SCOPES = ['openid', 'email', 'profile'];

export function protectedResourceMetadata(c: OAuthMetadataConfig) {
  return {
    resource: `${c.origin}/mcp`,
    authorization_servers: [c.origin],
    scopes_supported: ['openid'],
    bearer_methods_supported: ['header'],
  };
}

// Authorize and token requests go through the shim's `/authorize` redirect and
// `/token` forwarder, which strip `resource`: Cognito accepts it on authorize
// but then issues a code that cannot be redeemed (`invalid_grant`).
export function authorizationServerMetadata(c: OAuthMetadataConfig) {
  const pool = `https://cognito-idp.${c.region}.amazonaws.com/${c.userPoolId}`;
  return {
    issuer: c.origin,
    authorization_endpoint: `${c.origin}/authorize`,
    token_endpoint: `${c.origin}/token`,
    jwks_uri: `${pool}/.well-known/jwks.json`,
    registration_endpoint: `${c.origin}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: SCOPES,
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
  };
}
