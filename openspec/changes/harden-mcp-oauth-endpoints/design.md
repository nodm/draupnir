## Context

See proposal.md (Why) for the motivation. The current state:

- **`infra/lib/mcpApi.ts`** wires seven unauthenticated routes (`authorization: 'NONE'`) to one Lambda, `mcp-oauth`, through `AWS_PROXY` integrations:
  - four discovery GETs: `/.well-known/oauth-protected-resource`, `…/oauth-protected-resource/mcp`, `…/oauth-authorization-server` and `…/openid-configuration`;
  - `GET /authorize`, `POST /token` and `POST /register`.
- **Throttles:** the stage has a `*/*` throttle of 10/20, plus overrides `token/POST` 5/10 and `register/POST` 1/5. The `mcp` deployment's trigger hashes each route's path, method and integration URI.
- **`mcp/src/lib/oauth.ts`:**
  - builds the two metadata documents (`protectedResourceMetadata`, `authorizationServerMetadata`) from the origin, the user pool id and the region;
  - validates redirect URIs: the two claude callbacks, or `http` loopback on `localhost`/`127.0.0.1` with any port, at most 5 URIs;
  - names clients `mcp-dcr-<hash of the sorted URI set>` and stops at 25.
- **`mcp/src/oauth.ts`:** routes by `httpMethod resource` and returns the documents with `cache-control: public, max-age=300`.
- **Registered clients today:** three, all from 2026-11-07, within two seconds of each other: claude.ai, `http://localhost:33418/callback` and `http://127.0.0.1:33419/callback`.
- **Module boundaries:** `scope:infra` may import only `scope:shared`. Even `shared` is not resolvable from the Pulumi program at runtime: its package `main` points at a `.js` file that does not exist, and the program runs without tsconfig path mapping. Today only esbuild-bundled Lambda code in `infra/src` imports `shared`.

## Goals / Non-Goals

**Goals:**

- No Lambda runs for a discovery request.
- Every unauthenticated route has a limit sized to how often a real client calls it.
- Anonymous registrations can neither block nor pile up clients.
- claude.ai and claude.com connectors keep working, with their existing client.

**Non-Goals:**

- Removing the Lambda from `/authorize`. It must drop `resource` from an arbitrary query string; a mapping template could only approximate that, and the limit makes it cheap.
- A web application firewall or per-IP limits.
- Changing `/token` or `/register` limits, or the `POST /mcp` stage default.
- Supporting local clients that register themselves (loopback), as decided with the maintainer. They connect through the claude.ai connector instead.

## Decisions

### 1. Discovery documents as API Gateway MOCK integrations

Each of the four discovery methods gets these pieces:

- **Integration:** `type: 'MOCK'` with request template `{"statusCode": 200}` for `application/json`.
- **`IntegrationResponse`** for `200`:
  - `responseTemplates: { 'application/json': <document JSON> }`;
  - `responseParameters` that set `Content-Type: 'application/json'` and `Cache-Control: 'public, max-age=300'`.
- **`MethodResponse`** for `200` that declares both headers.

The deployment trigger and `dependsOn` include the new integration and method responses, so a content change redeploys the stage.

The document JSON is computed at deploy time:

```ts
pulumi.all([userPool.id]).apply(([id]) => JSON.stringify(protectedResourceMetadata({ origin, userPoolId: id, region })))
```

The origin comes from `mcpHost` and the region from `aws:region`.

**Mapping-template safety:** the template is literal VTL, so `$` and `#` in the JSON would be interpreted. The documents contain neither, and a test asserts it, so a later field cannot silently break the response.

**Alternatives considered:**
- *Keep the Lambda and only throttle:* that still runs a function per request.
- *Enable the API Gateway cache:* about $14/month minimum, which is more than the problem.
- *Static hosting on S3 behind CloudFront:* new resources, and the documents must stay on the MCP origin's well-known paths.

### 2. The metadata builders move to `infra`

`protectedResourceMetadata`, `authorizationServerMetadata` and their tests move from `mcp/src/lib/oauth.ts` to `infra/lib/mcpOAuthMetadata.ts`, which becomes the only producer of the documents. `mcp/src/oauth.ts` drops its four discovery cases. A request that still reached them would get the handler's `404`, but API Gateway no longer routes any there.

The scope list `['openid', 'email', 'profile']` then exists in two places:
- in `mcp`, where registration grants it to clients;
- in `infra`, where the metadata advertises it.

A comment in each file names the other.

**Alternatives considered:**
- *Move the builders to `shared`:* not importable by the Pulumi program at runtime (see Context), and making it importable means build tooling for one function.
- *Keep them in `mcp` and duplicate the JSON in `infra`:* two sources of truth with no test able to compare them across the boundary.

### 3. Per-method throttles

New `MethodSettings`, one per method:

| Methods | Limit |
|---|---|
| each of the four discovery GETs | 1 rps, burst 5 |
| `authorize/GET` | 1 rps, burst 5 |
| `token/POST` (unchanged) | 5 rps, burst 10 |
| `register/POST` (unchanged) | 1 rps, burst 5 |
| `*/*` default, which leaves only `POST /mcp` | 10 rps, burst 20 |

**Why 1 rps, burst 5:**
- A client fetches each discovery document once per connect and follows `/authorize` once per sign-in.
- Each method has its own bucket, so a connect that probes all four documents at once stays within the limits.
- The burst absorbs a reconnect or two.

**Anonymous ceilings:** Lambda-backed requests drop from about 56 rps to 7 rps (`/authorize` 1, `/token` 5, `/register` 1). Total API Gateway requests on the unauthenticated routes drop from about 66 rps to 11 rps.

**Method path format:** the overrides that exist today use top-level paths (`token/POST`). For the nested discovery paths, the code passes the resource's path without its leading slash, then `/GET`, for example `.well-known/oauth-protected-resource/mcp/GET`. That is the provider's documented form. The exact encoding is verified after the deploy with `aws apigateway get-stage … --query methodSettings`, which must list all eight keys. If AWS expects the `~1` encoding for nested paths, the fix is a one-line change of that format.

### 4. Registration allows only the two claude callbacks

`isAllowedRedirectUri` accepts exactly `https://claude.ai/api/mcp/auth_callback` and `https://claude.com/api/mcp/auth_callback`. The loopback branch and its URL parsing go away, and `MAX_REDIRECT_URIS` becomes 2.

The client name is a hash of the sorted URI set, so only three names are possible: `{ai}`, `{com}` and `{ai, com}`. Registration can therefore create at most three clients.

`MAX_CLIENTS` stays at 25 as a backstop. It costs nothing, and the "Registration is bounded" requirement keeps a fixed maximum.

The existing claude.ai client keeps its name, because the hash of `{ai}` is unchanged, so the connector reuses it without re-consent.

**One-off cleanup:** the two loopback clients from 2026-11-07 remain in Cognito, because runtime-created clients are outside Pulumi. They are deleted by hand after the deploy (Migration Plan step 5), with a command that selects clients by their callbacks, not by name. Tokens issued to those test clients stop working, which is intended.

### 5. Docs

- **`mcp/README.md`:**
  - remove the `claude mcp add --transport http` instructions;
  - say that local tools such as Claude Code connect through the claude.ai connector (signed in to the claude.ai account);
  - state the new registration rule.
- **ADR-0012** gets a dated note under its Deviations:
  - loopback registration is dropped (this change);
  - the "ID token from the pool also authenticates against the other APIs" deviation is resolved, because `remove-ingestion-api` left the MCP API as the only one with a user pool authorizer;
  - the stale-loopback cleanup paragraph no longer applies.
- **`infra/README.md` (API guardrails) and the `docs/architecture.md` concurrency note:** the new per-method limits and the ceilings from Decision 3.

### 6. Tests

**`infra`:**
- `mcpOAuthMetadata.spec.ts` holds the moved metadata tests, plus one asserting no `$` or `#` in either document.
- `guardrails.spec.ts`:
  - the throttle table matches Decision 3;
  - the four discovery integrations are `MOCK` and none points at `mcp-oauth`;
  - each has a `200` integration response whose template equals the builder's JSON, and the `Content-Type` and `Cache-Control` header mappings;
  - only `authorize`, `token` and `register` integrate with the OAuth Lambda.

**`mcp`:**
- loopback URIs are rejected;
- at most 2 URIs;
- the handler answers `404` for the removed discovery routes.

## Risks / Trade-offs

- **[A MOCK response differs from what the Lambda served (bytes, headers, content type)]** → Before deploying, save the four documents and their headers as served today. After deploying, fetch them again and compare the parsed JSON and the two headers. Byte-for-byte equality is not required, because `JSON.stringify` key order follows the builder, the same code the Lambda ran.
- **[A nested method path is encoded wrongly, so its override silently does not apply]** → `get-stage` after the deploy must show all eight method settings (Decision 3). Until fixed, the route falls back to the stage default of 10/20, which is today's behavior.
- **[Loopback-based local clients stop working]** → Accepted by the maintainer. The claude.ai connector covers Claude Code. A local client that needs loopback later would come with a design that cannot use up the cap (for example, evicting the oldest client).
- **[claude.ai registers a set this code no longer accepts]** → It registers only its own callback today, which is still accepted. The limits make a retry storm harmless.

## Migration Plan

1. Save the current discovery responses:

   ```bash
   for p in oauth-protected-resource oauth-protected-resource/mcp oauth-authorization-server openid-configuration; do
     curl -s -D - "https://mcp.draupnir.nodm.name/.well-known/$p"
   done > before.txt
   ```

2. Run `pnpm exec nx run infra:preview`. Expect:
   - changes to the four discovery integrations (MOCK);
   - creates for their integration and method responses and for the 5 new method settings;
   - a new `mcp` deployment and an updated stage;
   - an in-place update of the `mcp-oauth` function code;
   - **no deletes**, other than an integration being replaced if the provider cannot change its type in place.
3. Run `pnpm exec nx run infra:up`.
4. Verify:
   - the four documents match `before.txt` (parsed JSON, `Content-Type`, `Cache-Control`);
   - `get-stage --query methodSettings` lists the eight method keys with the limits from Decision 3;
   - the `mcp-oauth` function's invocation count does not move while the documents are fetched;
   - `POST /register` with a loopback URI answers `400`, and with the claude.ai callback answers `201` with the existing `client_id`;
   - an MCP tool call through the claude.ai connector works.
5. Delete the two loopback clients:

   ```bash
   POOL=$(pulumi stack output userPoolId)
   for id in $(aws cognito-idp list-user-pool-clients --user-pool-id "$POOL" --max-results 60 \
       --query "UserPoolClients[?starts_with(ClientName,'mcp-dcr-')].ClientId" --output text); do
     aws cognito-idp describe-user-pool-client --user-pool-id "$POOL" --client-id "$id" \
       --query 'UserPoolClient.CallbackURLs' --output text | grep -qE '^http://(localhost|127\.0\.0\.1):' \
       && echo aws cognito-idp delete-user-pool-client --user-pool-id "$POOL" --client-id "$id"
   done
   ```

   Run it with `echo` first and review the output, then without it.
6. Push the branch and open the PR.

**Rollback:** `git revert` the change and run `pulumi up`. The Lambda serves the discovery documents again under the old limits, and loopback registration is allowed again. The deleted test clients are not restored, and nothing needs them.
