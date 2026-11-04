# ADR-0002: Authenticated Request Flow

## Status

Accepted

## Date

2026-08-22

## Deciders

Dmytro Novikov

## Context

[ADR-0001](./0001-mcp-transport.md) settled the MCP server's transport (Lambda +
API Gateway REST API, `COGNITO_USER_POOLS` authorizer) but explicitly deferred two
things: how a human user's own requests (the primary app, not an MCP client) get
authenticated, and how the authorizer-injected identity concretely becomes a
row-level filter at the DB layer. This ADR resolves both, and confirms whether MCP
shares the same path.

Draupnir has exactly **two independent users** (me + wife), each signing in with
their own **Google account** via Cognito federation — there is no Draupnir-native
username/password. Cognito's federation behavior matters here: **Cognito always
mints its own `sub` (a UUID) per federated identity; it never copies the IdP's
`sub`, and it does not auto-link identities across users**. Two different Google
accounts signing into the same user pool land as two separate Cognito profiles
(`Google_<id-1>`, `Google_<id-2>`) with two separate `sub`s, with zero linking
configuration required on our side.
([docs: federated identity linking](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-identity-federation-consolidate-users.html))
This is what "not a merged pool" means concretely: it's not a design we have to
enforce, it's Cognito's default, and we must specifically avoid calling
`AdminLinkProviderForUser` or configuring `ProviderAttributeName: Cognito_Subject`
across the two identities, since that API exists precisely to merge federated
identities into one profile — the opposite of what we want.

Despite only two users today, this is a financial app: every row that isn't
literally global config data is owned by exactly one user, and the two users can
**opt in to sharing individual accounts or categories** with each other (Google
Photos-style: grant visibility into *this specific* thing, not "become the same
tenant"). The code must check ownership/grant on every read and write, not assume a
single-tenant shortcut now and retrofit later — retrofitting row-level checks into
queries that were written assuming one implicit tenant is exactly the kind of
expensive-to-reverse mistake ADRs exist to prevent.

Four concrete decisions were needed:

1. **Authorizer type** for API Gateway: native `COGNITO_USER_POOLS` authorizer vs.
   a custom Lambda authorizer.
2. **Token flow**: Cognito's hosted sign-in experience vs. hand-rolling a custom
   sign-in screen against the Cognito API directly.
3. **Sign-up restriction**: federated sign-up is otherwise open to any Google
   account — something has to enforce "only these specific two people."
4. **Identity → DB layer**: how the authenticated `sub` on a request becomes the
   predicate that scopes a query to what that user owns or has been granted.

## Decision

**1. Authorizer type — native `COGNITO_USER_POOLS` authorizer, same as ADR-0001,
reused for both the primary app API and the MCP server.**

One Cognito User Pool is the single identity source for the whole system. The
primary app's REST API and the MCP server each get their own API Gateway REST API
(different protocols, different Lambda code, different deploy lifecycles — no
reason to force them into one API Gateway resource), but both attach a
`COGNITO_USER_POOLS` authorizer pointed at the *same* user pool. A token issued by
one sign-in is valid against both surfaces. The authorizer's only job is JWT
validation + claims injection (`sub`, `email`) — it does no business-logic
resolution, no share-grant lookups, nothing that could go stale.

**2. Token flow — Cognito Managed Login, driven by Amplify Auth (Gen 2,
`aws-amplify` v6) `signInWithRedirect`. No custom sign-in UI, no
`amazon-cognito-identity-js`.**

Google is the *only* IdP. There is no username/password screen to build — every
sign-in is an OAuth redirect to Google via Cognito. AWS's current direction is
**Managed Login**, the successor to the classic Hosted UI, with a no-code
branding editor and native Amplify integration for social/OIDC/SAML federation.
([AWS: Managed Login announcement](https://aws.amazon.com/about-aws/whats-new/2024/11/amazon-cognito-managed-login))
`amazon-cognito-identity-js` was considered and rejected outright, not just
disfavored: npm's own package notice says it's superseded by Amplify Auth, its
original repo is archived, and — more fundamentally — it implements Cognito's
native SRP username/password flow, not the OAuth Authorization Code + PKCE flow a
federated-only IdP setup requires. It's not a lighter-weight alternative here, it's
the wrong protocol for this login shape.
([npm: amazon-cognito-identity-js](https://www.npmjs.com/package/amazon-cognito-identity-js))
Amplify Auth's `signInWithRedirect` is the client-side piece that triggers the
Managed Login redirect and handles the callback: PKCE, token exchange, secure
token storage, and refresh. It's a thin wrapper around the same hosted redirect,
not a competing option to it.

**3. Sign-up restriction — a Pre Sign-Up Lambda trigger (`PreSignUp_ExternalProvider`)
allowlisting by email, rejecting anyone else before Cognito creates a profile.**

Federated sign-up in Cognito is **just-in-time**: the first successful Google OAuth
callback for an email Cognito hasn't seen creates a new user pool profile
automatically. `AllowAdminCreateUserOnly` does not stop this — it only blocks
*native* username/password self-registration, not federated sign-up. Left
unaddressed, "two independent users" would be an assumption nobody enforces: any
Google account could complete the OAuth redirect and get a profile in a financial
app. The trigger fires on every federated sign-up attempt and checks the incoming
`email` claim against a small allowlist (a Lambda env var/config value is enough at
this size — not a DB table), throwing to abort creation for anyone not on it.
([docs: Pre sign-up Lambda trigger](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-pre-sign-up.html))

**4. Identity → DB layer — claims pass through to the handler; ownership and
share-grants are query-time predicates. No precomputed/cached permissions
object.**

The authorizer injects `sub` (and `email`) into
`event.requestContext.authorizer.claims`. The handler reads `sub` once per request
and threads it into every query as a bind parameter — never as a value trusted
from the request body/path/query string. Two predicate shapes cover everything:

- **Owned rows**: `WHERE owner_user_id = :sub`.
- **Shared rows**: a `share_grants` table (`grantor_user_id`, `grantee_user_id`,
  `resource_type`, `resource_id`) joined in as
  `WHERE owner_user_id = :sub OR EXISTS (SELECT 1 FROM share_grants sg WHERE
  sg.grantee_user_id = :sub AND sg.resource_type = 'account' AND
  sg.resource_id = accounts.id)`.

No permissions object is precomputed or cached per request or per session.

## Options Considered

**Authorizer type**

| Option | Effort | Staleness risk | Fit |
|---|---|---|---|
| Native `COGNITO_USER_POOLS` (chosen) | Lowest — zero code | None — validates the live JWT every request | Matches ADR-0001; identical pattern on both surfaces |
| Lambda authorizer | Higher — custom code + IAM policy generation | **High** — API Gateway caches the authorizer's response for up to 3600s by token, so a revoked share grant baked into a custom-authorizer decision could stay visible for up to an hour | Only worth it for logic the native authorizer can't express — we don't have any |

**Token flow**

| Option | Effort | Protocol fit | Maintenance |
|---|---|---|---|
| Managed Login + Amplify Auth `signInWithRedirect` (chosen) | Low — hosted page, SDK handles PKCE/refresh | Correct — OAuth Authorization Code + PKCE, what federation requires | AWS-maintained, current direction |
| Classic Hosted UI | Low | Correct | Functionally fine, but AWS is steering new customization/branding work to Managed Login, not Hosted UI |
| Custom sign-in screen via `amazon-cognito-identity-js` | Highest — build + maintain a UI for zero functional gain | **Wrong** — SRP flow, not built for federated OAuth redirect | Package superseded, original repo archived |

**Sign-up restriction**

| Option | Enforced by | Blast radius if skipped |
|---|---|---|
| Pre Sign-Up Lambda trigger, email allowlist (chosen) | Cognito itself, before profile creation | N/A — this is the baseline |
| `AllowAdminCreateUserOnly` | Nothing — doesn't apply to federated sign-up at all | Any Google account gets a profile in a financial app |
| Rely on app-level checks after sign-in | The handler, post-hoc | A stray profile already exists in Cognito; app code has to remember to reject it everywhere, forever |

**Identity → DB layer**

| Option | Correctness under revoke | Complexity | Fit at N=2 users |
|---|---|---|---|
| Query-time predicate from claims (chosen) | Immediate — a revoked grant disappears from the very next query, no invalidation path to get wrong | Lowest — one `EXISTS` join, no new subsystem | Right-sized |
| Precomputed/cached permissions object (resolved once, attached to request or cached in a session store) | Requires explicit invalidation on every grant/revoke or the cache silently lies | Higher — a cache + its invalidation is now part of the auth-correctness surface | Premature — grants are single digits in count per user, nothing to amortize |

## Trade-off Analysis

- **Why not a Lambda authorizer for the share-grant check specifically**: it's
  tempting to resolve "what can this user see" once at the authorizer layer and
  hand the handler a ready-made resource-ID list. Rejected because API Gateway's
  authorizer response caching (5 min default, configurable up to 1 hour) means a
  revoked share could remain effectively granted for up to an hour after revoke —
  unacceptable staleness for a financial app where "stop sharing this account with
  you" needs to mean *now*. Keeping the authorizer dumb (JWT validation only) and
  re-checking grants on every query sidesteps the entire cache-invalidation
  question by never introducing the cache.
- **Why not precompute a permissions object per request either**: same failure
  mode one layer down — even without cross-request caching, resolving "all
  resource IDs this user can see" once per request and then filtering in Lambda
  memory means every code path that touches data must remember to consult that
  object correctly, and a new query added later that forgets to check it fails
  open (returns unfiltered data) rather than closed. A query-time `WHERE`/`EXISTS`
  predicate can't be forgotten in the same way — it's part of the query itself,
  and it's the same shape whether there are 2 users or 200.
- **Why Managed Login over Hosted UI when both work today**: no functional
  difference for a Google-only flow right now, but Managed Login is where AWS is
  investing (branding editor, native Amplify social/OIDC/SAML integration), and
  there's no cost to starting there — it's the same OAuth redirect underneath, so
  this isn't a "pay more now for future flexibility" trade like ADR-0001's REST vs
  HTTP API call, it's simply the currently-recommended entry point with no
  offsetting downside.
- **Scaling this to N users**: nothing here is a 2-user shortcut. `owner_user_id`
  and `share_grants` are already general — adding a third user is a new Cognito
  profile and, optionally, new rows in `share_grants`; no query changes anything
  about "who is user 1 and user 2."

## Consequences

- Every new table that stores user data needs an `owner_user_id` column from day
  one, and every query against it needs the ownership/grant predicate — there is
  no "trusted internal service" shortcut, since the whole app is the trust
  boundary here (single backend, no service-to-service calls yet).
- `share_grants` needs its own ownership rule: only the resource's owner may
  insert/delete a grant for it (`grantor_user_id` must equal the owner, checked
  the same way as any other write).
- The Lambda handler must treat `event.requestContext.authorizer.claims.sub` as
  the *only* legitimate source of "who is making this request" — this was already
  a constraint from ADR-0001 for MCP, now confirmed as the rule everywhere,
  including the primary app API.
- This ADR does **not** resolve ADR-0001's still-open action item on the MCP
  client-registration/OAuth flow for Claude Desktop — that's a different question
  (how a non-human MCP client obtains a token from this same user pool), left for
  its own ADR as originally noted. Decision #1's "same authorizer, same pool"
  covers a token *once a client has one*; it says nothing about how an MCP client
  gets one, and that step is not a rubber stamp. The 2026-07-28 spec tightened
  MCP's OAuth requirements — RFC 9207 issuer validation, Client ID Metadata
  Documents replacing Dynamic Client Registration — but the sharper problem
  predates that revision: MCP requires clients to send the RFC 8707 `resource`
  parameter (binding the token's `aud` to this specific MCP server), and **Cognito
  does not honor it** — it mints API-scoped tokens from a pre-RFC-8707 `audience`/
  resource-server parameter instead, the same gap reported for Auth0.
  ([RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728),
  [MCP servers whose AS is Auth0/Cognito can't complete the flow as specced](https://github.com/danny-avila/LibreChat/issues/13401))
  So the deferred ADR isn't just "map DCR onto Cognito's app-client model," it's
  "Cognito can't be the MCP authorization server as-is" — the realistic shape is
  an OAuth proxy in front of Cognito (hosts `/.well-known/oauth-protected-resource`
  per RFC 9728, translates the client's `resource` into Cognito's `audience`) or
  a deliberate, documented non-compliance (skip resource indicators — defensible
  for a single personal MCP server with one possible audience, but a real spec
  deviation to write down, not silently drop).
- Sharing is scoped to `account` and `category` as the two `resource_type`s for
  now; extending `share_grants` to a new resource type later is additive (new
  enum value + new `EXISTS` join at the relevant query sites), not a schema
  migration of existing data.

## Action Items

- [ ] Separate ADR (supersedes the vague pointer in ADR-0001): MCP client
      auth flow for Claude Desktop↔Cognito, given Cognito doesn't honor RFC 8707
      `resource` — decide OAuth-proxy-in-front-of-Cognito vs. documented
      non-compliance, plus CIMD-vs-DCR and RFC 9207 issuer validation per the
      2026-07-28 spec.
- [ ] Provision one Cognito User Pool (Google as the only federated IdP, no
      native username/password) shared by the primary app API and the MCP server.
- [ ] Enable Managed Login on the user pool; do not configure
      `AdminLinkProviderForUser`/`Cognito_Subject` account linking — confirm this
      stays off as new IdPs are ever considered.
- [ ] Implement the `PreSignUp_ExternalProvider` Lambda trigger with the two-email
      allowlist; deploy it before the user pool is reachable by anyone — this is
      the actual access boundary, not the app code.
- [ ] Add `COGNITO_USER_POOLS` authorizers (Pulumi) on both the primary app REST
      API and the MCP REST API from ADR-0001, both referencing the same pool.
- [ ] Wire `aws-amplify` v6 `signInWithRedirect`/`fetchAuthSession` in the client;
      confirm current Amplify Auth Gen 2 API surface before implementing — don't
      assume this ADR's API names are still current by the time it's built.
- [ ] Design the `share_grants` table (grantor, grantee, resource_type,
      resource_id, created_at) and the write-side rule restricting inserts/deletes
      to the resource's owner.
- [ ] Add the ownership/grant `WHERE`/`EXISTS` predicate to every existing and new
      query touching user-owned tables; add a lint/review checklist item so this
      isn't only caught by code review memory.
- [ ] Revisit if a third user is ever added — expected to be a no-op per the
      Trade-off Analysis, but confirm no query assumed exactly two users.
