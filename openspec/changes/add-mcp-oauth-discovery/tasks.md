## 1. Registration and metadata logic

- [x] 1.1 Add the `oauth` Lambda entry point in `mcp` with the protected resource and OIDC
      metadata documents built from env (MCP origin, Managed Login base URL, user pool id);
      verify unit tests assert `resource` is `<origin>/mcp`, `authorization_servers`, `issuer`
      equal to the advertised issuer, `S256`, `registration_endpoint`, and public-client auth method.
- [x] 1.2 Implement redirect-URI validation (claude.ai/claude.com callbacks, `http` loopback
      with port and path, max 5, nothing else); verify unit tests cover each allowed form and
      refuse another host, `http` non-loopback, missing port, and an empty list.
- [x] 1.3 Implement `POST /register` against a mocked Cognito client: name from the sorted
      redirect set, reuse on a name match, create otherwise, cap of 25, RFC 7591 response with
      no secret, error bodies for invalid input; verify unit tests cover create, idempotent
      reuse, cap reached with a new set, cap reached with a known set, and the exact create
      settings (Google only, PKCE-capable public client, scopes, callbacks).

## 2. Infra

- [x] 2.0 Add the custom domain in `infra/lib/mcpApi.ts` (or a sibling module): config
      keys for the hostname (`mcp.draupnir.nodm.name`) and hosted zone (`nodm.name`), ACM certificate with Route53 DNS validation,
      regional API Gateway domain name, empty base path mapping to the `mcp` stage, alias
      A record; verify `infra:build` passes and `infra:preview` shows only these new
      resources.
- [x] 2.1 In `infra/lib/mcpApi.ts` add the `mcp-oauth` Lambda, its role (CloudWatch logs;
      `cognito-idp:CreateUserPoolClient`, `ListUserPoolClients`, `CreateManagedLoginBranding`
      and `DeleteUserPoolClient` on the user pool ARN only), the unauthenticated routes (protected resource at the root and the `/mcp`-suffixed
      path, authorization server and OIDC metadata, `POST /register`), and `UNAUTHORIZED`
      gateway response with the `WWW-Authenticate: Bearer resource_metadata=…` header on the
      custom domain; include the new routes in the
      deployment trigger; verify `pnpm exec nx run infra:build` and `infra:preview` show only
      additive resources plus the `/mcp` method change.
- [x] 2.2 Set `authorizationScopes: ['openid']` on the `/mcp` method and low-rate throttling on
      `POST /register`; verify the preview shows the method and method-settings changes and
      nothing replaced on the `mcp` Lambda.
- [x] 2.3 Wire the user pool ARN/id, Managed Login base URL and MCP host from `index.ts` and
      `cognito.ts` into `createMcpApi`; verify `infra:build` and lint pass.

## 3. Deploy and verify against Cognito (prod apply is run by the user)

- [x] 3.1 `pnpm exec nx run infra:up`; confirm the certificate is issued and
      `https://<mcpHost>/.well-known/oauth-protected-resource/mcp` returns `200`; call `/register` with a claude.ai callback and with a
      loopback callback on both `127.0.0.1` and `localhost`; verify the response is `201`
      for each and note which loopback hosts Cognito accepts.
- [x] 3.2 With the new client, sign in through Managed Login (PKCE) and call `tools/list`
      with the **access token** on the custom domain; verify it succeeds, an ID token gets `401` with the
      challenge header, and no-token gets `401` with the challenge header. If the scope
      approach does not authenticate, stop and update design.md (Lambda authorizer fallback).
- [x] 3.3 Repeat the authorize and token requests with `resource=<MCP URL>`; verify they
      complete. Result: a code issued after an authorize request with `resource` cannot be
      redeemed (`invalid_grant`), so `GET /authorize` (redirect without `resource`) and
      `POST /token` (forwarder) are added with tests, routes and throttle; re-verify the
      flow through both.

## 4. Clients and records

- [ ] 4.1 Connect each client from only the MCP URL and verify `tools/list` and one tool call:
      Claude Desktop or claude.ai custom connector, Claude Code (`claude mcp add --transport
      http`), and one other client (Cursor or VS Code). Record per client what worked and
      any callback URL not in the allowlist; adjust the allowlist constant if needed.
      Verified 2026-11-07: Claude Desktop (connector from the MCP URL only) works end to end.
      Pending: Claude Code and one other client.
- [x] 4.2 Write `docs/adr/0012-mcp-client-authorization.md` (shim over proxy, access tokens,
      per-redirect-set clients, `resource`/audience deviation, RFC 9207 note, custom domain
      follow-up) and tick the ADR-0001 and ADR-0002 action items; update `mcp/README.md`
      with the connection steps and the cleanup command for `mcp-dcr-` clients; verify
      the links resolve.
- [x] 4.3 Verify `pnpm exec nx run-many -t lint test build -p mcp infra shared` passes.
