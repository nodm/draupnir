## 1. MCP server dependency and handler

- [x] 1.1 Add `@modelcontextprotocol/server` (v2, currently `2.0.0`) to
      `mcp/package.json`/workspace deps — not the frozen v1
      `@modelcontextprotocol/sdk`; the 2026-07-28 transport lives in v2's
      `createMcpHandler` (confirmed via the SDK's `docs/migration/upgrade-to-v2.md`
      and npm registry, per ADR-0001's action item to re-check, not assume) —
      and verify `pnpm install` resolves cleanly.
- [x] 1.2 Implement `mcp/src/lib/mcp.ts`: build an MCP server via
      `createMcpHandler(() => new McpServer(...))` (registers one `whoami` tool
      proving claim wiring, per design.md) and export the resulting
      `McpHttpHandler`; verified via a unit test using `StreamableHTTPClientTransport`
      in-process (initialize + `tools/call` round trip reflects the injected sub,
      ignores a body-supplied one) and a malformed-body case returning a JSON-RPC
      error response rather than throwing (`mcp-server-api` spec).
- [x] 1.3 Replace `mcp/src/handler.ts`'s no-op with a `Handler<
      APIGatewayProxyWithCognitoAuthorizerEvent, APIGatewayProxyResult>` that reads
      `event.requestContext.authorizer.claims.sub`, builds a web-standard `Request`
      from the API Gateway event (method, headers, body), calls 1.2's
      `mcpHandler.fetch`, and converts the resulting `Response` back to an
      `APIGatewayProxyResult`; verified via unit tests (mocking `./lib/mcp`) that a
      valid authenticated request forwards correctly, a body-supplied identifier is
      ignored, and a missing `sub` claim is rejected with 401 without invoking the
      MCP handler (`mcp-server-api` spec's claim-only requirement).
- [x] 1.4 Remove the now-unused placeholder `mcp()` export from
      `mcp/src/lib/mcp.ts` (and its spec) once nothing references it — done as
      part of 1.2/1.3, which replaced rather than extended the placeholder file;
      verified `nx run mcp:build` and `nx run mcp:test` pass, and `nx run mcp:lint`
      is clean.

## 2. Pulumi infrastructure

- [ ] 2.1 Implement `infra/lib/mcpApi.ts` exporting `createMcpApi(userPool,
      provider)`: a new regional `aws.apigateway.RestApi`, a new
      `COGNITO_USER_POOLS` `aws.apigateway.Authorizer` bound to the same
      `userPool.arn` `ingestion` uses, and one route built via
      `createLambdaRoute` (imported/exported from `ingestionApi.ts`, or hoisted
      to a shared module if that reads cleaner) pointing at `dist/mcp` and
      `handler.handler`; verify `nx run infra:build` succeeds.
- [ ] 2.2 Add the deployment + stage for the new REST API, following
      `ingestionApi.ts`'s pattern of hashing route config (not resource ids) into
      the deployment's `triggers`; verify `pulumi preview` shows the expected new
      resources (Lambda, REST API, authorizer, deployment, stage) with no errors
      and no unexpected diff to existing `ingestion` resources.
- [ ] 2.3 Wire `createMcpApi` into `infra/index.ts` alongside the existing
      `createIngestionApi` call, using the same `authPool.userPool` and
      `provider`; export `mcpApiId` and `mcpInvokeUrl`; verify `pulumi preview`
      shows no drift to unrelated resources.

## 3. End-to-end verification

- [ ] 3.1 Deploy to the test/dev stack and send an authenticated `POST` (a real
      Cognito JWT from the shared pool) with a well-formed JSON-RPC request body
      to the deployed invoke URL; verify the response is a JSON-RPC response
      correlated to the request id and reflects that token's `sub`.
- [ ] 3.2 Send the same request with no `Authorization` header and with an
      expired/malformed token; verify both are rejected by the authorizer (403,
      Lambda not invoked — confirm via logs) per the `mcp-server-api` spec's
      authorizer scenarios.
