## Why

ADR-0001 deferred how human users (not MCP clients) authenticate, and ADR-0002
resolved that: one Cognito User Pool, Google as the only federated IdP, a
query-time ownership/share-grant predicate at the DB layer. Nothing in the
workspace implements this yet — every table added from here on (starting with
the transaction-store schema, next change) needs `owner_user_id` and the
matching predicate pattern to exist first, or it gets bolted on after the
fact, which ADR-0002 explicitly calls out as the expensive mistake to avoid.

## What Changes

- Provision one Cognito User Pool with Google as the sole federated IdP (no
  native username/password), Managed Login enabled, in `infra`.
- Add a `PreSignUp_ExternalProvider` Lambda trigger allowlisting exactly two
  emails, deployed as part of the pool so no unallowlisted Google account can
  ever obtain a profile.
- Attach a native `COGNITO_USER_POOLS` API Gateway authorizer, pointed at the
  pool, to a new `ingestion` REST API (the primary app's API surface).
  Attaching the same authorizer to `mcp`'s REST API is deferred: ADR-0001 left
  "add Pulumi resources: Lambda, REST API, Cognito authorizer" as an unchecked
  action item, so `mcp` has no REST API in Pulumi yet to attach to — a future
  change provisions it and wires the authorizer at the same time.
- Add an authenticated `GET /whoami` endpoint in `ingestion` that reads
  `event.requestContext.authorizer.claims.sub`/`email` and returns them,
  proving the token-to-claims path end-to-end without touching real data.
- Add the `share_grants` table shape (`grantor_user_id`, `grantee_user_id`,
  `resource_type`, `resource_id`, `created_at`) and the query-time
  ownership/share predicate pattern (`WHERE owner_user_id = :sub OR EXISTS
(...)`) as a documented pattern in `shared`, with a write-side rule that
  only a resource's owner may insert/delete a grant for it. No real
  `resource_type` beyond `account`/`category` is wired to a table yet — the
  transaction-store change does that.
- Wire `aws-amplify` v6 (`signInWithRedirect`/`fetchAuthSession`) as the
  intended client-side token flow; no UI ships in this change since no
  `scope:web` package exists — this is the auth-side contract that future
  client work will call against.

## Capabilities

### New Capabilities

- `user-authentication`: Cognito User Pool provisioning (Google federation,
  Managed Login, Pre-Sign-Up allowlist trigger), the `COGNITO_USER_POOLS`
  authorizer attached to `ingestion`'s new API (`mcp`'s attachment deferred —
  see Impact), and the authenticated `whoami` endpoint that proves claims
  reach a handler.
- `row-level-authorization`: the `owner_user_id` ownership predicate,
  the `share_grants` table shape, the query-time `WHERE`/`EXISTS` predicate
  pattern every user-owned table and query must follow, and the write-side
  rule restricting grant mutations to the resource's owner.

### Modified Capabilities

- `monorepo-workspace`: retires the "infra stays resource-free" requirement —
  `infra`'s Pulumi program now provisions the Cognito User Pool and `ingestion`
  API Gateway REST API this change needs, while still declaring nothing
  speculative (no VPC/S3/SQS until a change that needs one lands, per
  ADR-0003/ADR-0004). No requirement in `module-boundary-enforcement` changes.

## Impact

- **`infra`**: new Cognito User Pool, Google IdP config, Managed Login
  domain/branding, Pre-Sign-Up Lambda trigger + allowlist config, one
  `COGNITO_USER_POOLS` authorizer attached to `ingestion`'s new REST API.
- **`ingestion`**: new API Gateway REST API resource, `GET /whoami` handler.
- **`mcp`**: unchanged in this change. Its REST API + authorizer attachment
  from ADR-0001 was never actually provisioned in Pulumi and is deferred to a
  future change (see the deferred-authorizer note above).
- **`shared`**: ownership/share-grant predicate helper(s) and the
  `share_grants` table shape, consumed by both `ingestion` and `mcp`.
- **Dependencies**: `aws-amplify` v6 added as a future client dependency
  (declared, not consumed by any code yet — no `scope:web` package exists).
- **Out of scope**: any login UI, the transaction-store schema itself, and
  the MCP client-registration/OAuth flow for Claude Desktop (left to ADR-0002's
  own deferred action item).
