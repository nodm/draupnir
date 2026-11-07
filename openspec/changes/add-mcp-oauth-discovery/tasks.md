## 1. Registration and metadata logic

- [ ] 1.1 Add the `oauth` Lambda entry point in `mcp` with the protected resource and OIDC
      metadata documents built from env (MCP origin, Managed Login base URL, user pool id);
      verify unit tests assert `resource` is `<origin>/mcp`, `authorization_servers`, `issuer`
      equal to the advertised issuer, `S256`, `registration_endpoint`, and public-client auth method.
- [ ] 1.2 Implement redirect-URI validation (claude.ai/claude.com callbacks, `http` loopback
      with port and path, max 5, nothing else); verify unit tests cover each allowed form and
      refuse another host, `http` non-loopback, missing port, and an empty list.
- [ ] 1.3 Implement `POST /register` against a mocked Cognito client: name from the sorted
      redirect set, reuse on a name match, create otherwise, cap of 25, RFC 7591 response with
      no secret, error bodies for invalid input; verify unit tests cover create, idempotent
      reuse, cap reached with a new set, cap reached with a known set, and the exact create
      settings (Google only, PKCE-capable public client, scopes, callbacks).

## 2. Infra

- [ ] 2.0 Add the custom domain in `infra/lib/mcpApi.ts` (or a sibling module): config
      keys for the hostname (`mcp.draupnir.nodm.name`) and hosted zone (`nodm.name`), ACM certificate with Route53 DNS validation,
      regional API Gateway domain name, empty base path mapping to the `mcp` stage, alias
      A record; verify `infra:build` passes and `infra:preview` shows only these new
      resources.
- [ ] 2.1 In `infra/lib/mcpApi.ts` add the `mcp-oauth` Lambda, its role (CloudWatch logs;
      `cognito-idp:CreateUserPoolClient` and `ListUserPoolClients` on the user pool ARN
      only), the unauthenticated routes (protected resource at the root and the `/mcp`-suffixed
      path, authorization server and OIDC metadata, `POST /register`), and `UNAUTHORIZED`
      gateway response with the `WWW-Authenticate: Bearer resource_metadata=…` header on the
      custom domain; include the new routes in the
      deployment trigger; verify `pnpm exec nx run infra:build` and `infra:preview` show only
      additive resources plus the `/mcp` method change.
- [ ] 2.2 Set `authorizationScopes: ['openid']` on the `/mcp` method and low-rate throttling on
      `POST /register`; verify the preview shows the method and method-settings changes and
      nothing replaced on the `mcp` Lambda.
- [ ] 2.3 Wire the user pool ARN/id, Managed Login base URL and MCP host from `index.ts` and
      `cognito.ts` into `createMcpApi`; verify `infra:build` and lint pass.

## 3. Deploy and verify against Cognito (prod apply is run by the user)

- [ ] 3.1 `pnpm exec nx run infra:up`; confirm the certificate is issued and
      `https://<mcpHost>/.well-known/oauth-protected-resource/mcp` returns `200`; call `/register` with a claude.ai callback and with a
      loopback callback on both `127.0.0.1` and `localhost`; verify the response is `201`
      for each and note which loopback hosts Cognito accepts.
- [ ] 3.2 With the new client, sign in through Managed Login (PKCE) and call `tools/list`
      with the **access token** on the custom domain; verify it succeeds, an ID token gets `401` with the
      challenge header, and no-token gets `401` with the challenge header. If the scope
      approach does not authenticate, stop and update design.md (Lambda authorizer fallback).
- [ ] 3.3 Repeat the authorize and token requests with `resource=<MCP URL>`; verify they
      complete. If Cognito rejects `resource`, stop and add the `/authorize` redirect and
      `/token` forwarder routes (design decision 6) before continuing.

## 4. Clients and records

- [ ] 4.1 Connect each client from only the MCP URL and verify `tools/list` and one tool call:
      Claude Desktop or claude.ai custom connector, Claude Code (`claude mcp add --transport
      http`), and one other client (Cursor or VS Code). Record per client what worked and
      any callback URL not in the allowlist; adjust the allowlist constant if needed.
- [ ] 4.2 Write `docs/adr/0012-mcp-client-authorization.md` (shim over proxy, access tokens,
      per-redirect-set clients, `resource`/audience deviation, RFC 9207 note, custom domain
      follow-up) and tick the ADR-0001 and ADR-0002 action items; update `mcp/README.md`
      with the connection steps and the cleanup command for `mcp-dcr-` clients; verify
      the links resolve.
- [ ] 4.3 Verify `pnpm exec nx run-many -t lint test build -p mcp infra shared` passes.
