## 1. MCP server dependency and handler

- [ ] 1.1 Add `@modelcontextprotocol/sdk` to `mcp/package.json`/workspace deps;
      confirm the installed version's Streamable HTTP transport implements
      protocol revision 2026-07-28 (check the SDK's own version/changelog, per
      ADR-0001's action item — do not assume) and verify `pnpm install` resolves
      cleanly.
- [ ] 1.2 Implement `mcp/src/lib/mcp.ts`: build an MCP server instance (no tools
      registered yet) and a function that handles one Streamable HTTP POST —
      given a JSON-RPC request body and a caller `sub`, return a JSON-RPC
      response; verify a unit test posts a well-formed JSON-RPC request and
      asserts a correlated JSON-RPC response, and a malformed-body case returns
      a JSON-RPC error rather than throwing (`mcp-server-api` spec).
- [ ] 1.3 Replace `mcp/src/handler.ts`'s no-op with an `APIGatewayProxyHandler`
      that reads `event.requestContext.authorizer.claims.sub`, parses
      `event.body` as the JSON-RPC request, delegates to 1.2's function, and
      returns its response as the proxy result body; verify unit tests cover a
      valid authenticated request and confirm the handler never reads any
      identifier from the parsed body (`mcp-server-api` spec's claim-only
      requirement).
- [ ] 1.4 Remove the now-unused placeholder `mcp()` export from
      `mcp/src/lib/mcp.ts` (and its spec) once nothing references it; verify
      `nx run mcp:build` and `nx run mcp:test` still pass.

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
