## 1. Metadata builders move to infra

- [x] 1.1 Create `infra/lib/mcpOAuthMetadata.ts` with `protectedResourceMetadata` and `authorizationServerMetadata` moved from `mcp/src/lib/oauth.ts`, unchanged in output. Add a comment that the scope list mirrors `mcp`'s registration `SCOPES` (design Decision 2). Move their tests to `infra/src/mcpOAuthMetadata.spec.ts` and add a test that neither document contains `$` or `#`. Verify with `pnpm exec nx test infra`.
- [x] 1.2 Remove the two builders and the four discovery cases from `mcp/src/lib/oauth.ts` and `mcp/src/oauth.ts`, along with their tests. Add a handler test that the removed discovery routes answer `404`, and leave a comment in `mcp/src/lib/oauth.ts` pointing to `infra` for the metadata scope list. Verify with `pnpm exec nx test mcp`.

## 2. Registration restricted to the claude callbacks

- [x] 2.1 In `mcp/src/lib/oauth.ts`, accept only the two claude callbacks: drop the loopback branch and `LOOPBACK_HOSTS`, and set `MAX_REDIRECT_URIS = 2`. Update the tests: loopback URIs (`localhost` and `127.0.0.1`, any port) are rejected with `invalid_redirect_uri` and create nothing; both callbacks together are accepted; a third URI is refused (design Decision 4). Verify with `pnpm exec nx test mcp`.

## 3. Discovery as MOCK integrations and per-method throttles

- [x] 3.1 In `infra/lib/mcpApi.ts`:
  - change the four discovery routes to `MOCK` integrations, with an `IntegrationResponse` (template from `mcpOAuthMetadata.ts`, built with the user pool id, `aws:region` and the MCP origin) and a `MethodResponse` for `200` that sets `Content-Type: application/json` and `Cache-Control: public, max-age=300`;
  - keep `authorize`, `token` and `register` on the `mcp-oauth` Lambda;
  - add the new responses to the deployment trigger and `dependsOn` (design Decision 1).

  Verify with `pnpm exec nx run infra:build`.
- [x] 3.2 Add `MethodSettings` of 1 rps / burst 5 for each discovery GET and for `authorize/GET`, with the method path built from the resource path without its leading slash (design Decision 3). Verify with `pnpm exec nx run infra:build`.

## 4. Guardrail tests

- [x] 4.1 Extend `infra/src/guardrails.spec.ts`:
  - the MCP throttle table equals design Decision 3 (`*/*` 10/20, `token/POST` 5/10, `register/POST` 1/5, and 1/5 for the four discovery paths and `authorize/GET`);
  - the four discovery integrations are `MOCK`, and none references the `mcp-oauth` function;
  - each has a `200` integration response whose `application/json` template equals the builder's JSON for the test config, with the two header mappings;
  - exactly `authorize`, `token` and `register` integrate with `mcp-oauth`.

  Update the header comment. Verify with `pnpm exec nx test infra`.
- [x] 4.2 Temporarily point one discovery route back at the Lambda (or drop its throttle override), confirm that a test from 4.1 fails, then revert. Note the failing assertion for the PR description.

## 5. Docs and spec

- [x] 5.1 In `mcp/README.md`, replace the `claude mcp add` line with connecting through the claude.ai connector (which Claude Code also uses when signed in to the claude.ai account), and state that `/register` accepts only the claude.ai and claude.com callbacks. Verify with Prettier, and check that `grep -n "loopback\|claude mcp add" mcp/README.md` returns nothing.
- [x] 5.2 Add a dated note under Deviations in `docs/adr/0012-mcp-client-authorization.md`: loopback registration is dropped, the ID-token deviation is resolved by `remove-ingestion-api`, and the stale-loopback cleanup no longer applies (design Decision 5). Verify by reading the section.
- [x] 5.3 Update `infra/README.md` (API guardrails table, per-method overrides and ceilings) and the concurrency note in `docs/architecture.md` with the limits and ceilings from design Decision 3. Verify with Prettier and by checking that the table matches the guardrail test.
- [x] 5.4 Run `pnpm exec openspec validate harden-mcp-oauth-endpoints --strict` and confirm that it passes.

## 6. Full checks

- [x] 6.1 Run `pnpm exec nx run-many -t lint build test --all --parallel=1` and confirm that every project passes.

## 7. Deploy (with the maintainer, before the branch is pushed)

- [x] 7.1 Save the four discovery responses with headers (design Migration Plan, step 1). Run `pnpm exec nx run infra:preview` and confirm that the changes match step 2: no deletes, beyond an integration replacement if the provider needs one. Then run `pnpm exec nx run infra:up` after the maintainer confirms.
- [x] 7.2 Verify the deploy (Migration Plan, step 4): the documents match the saved ones (parsed JSON and the two headers); `get-stage` lists the eight method settings with the expected limits; the `mcp-oauth` invocation count does not move while the documents are fetched; `/register` refuses a loopback URI and returns the existing `client_id` for the claude.ai callback; an MCP tool call through the claude.ai connector works.
- [x] 7.3 Delete the two loopback clients with the reviewed command from the Migration Plan, step 5. Verify that only the claude.ai `mcp-dcr-` client and `draupnir-telegram` remain in the pool.
