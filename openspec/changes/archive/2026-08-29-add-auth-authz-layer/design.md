## Context

See `proposal.md` - Why. The concrete decisions this design implements come
from [ADR-0002](../../../../docs/adr/0002-auth-request-flow.md), already
accepted: native `COGNITO_USER_POOLS` authorizer, Managed Login via Amplify
Auth `signInWithRedirect`, a Pre-Sign-Up allowlist trigger, and a query-time
ownership/share-grant predicate with no cached permissions object. This
design covers only how those decisions land inside the workspace's existing
four scope tags (`ingestion`, `mcp`, `shared`, `infra`) — see
`openspec/specs/monorepo-workspace` and
`openspec/specs/module-boundary-enforcement`, which this change must not
violate.

The whoami endpoint's home was a material scope decision, resolved with the
user before writing this design: it lives in `ingestion`, on a **new** API
Gateway REST API for that project, not as an additional route bolted onto
`mcp`'s existing API from ADR-0001. `ingestion` is the closest thing the
workspace has to a "primary app backend" today, and ADR-0002 already commits
to the primary app getting its own API Gateway REST API separate from MCP's.

## Goals / Non-Goals

**Goals:**

- Stand up one Cognito User Pool that `ingestion`'s new API trusts via a
  `COGNITO_USER_POOLS` authorizer, exporting the pool ARN so a future change
  can attach `mcp`'s authorizer to the same pool without re-deciding
  anything (see the Non-Goals note on the deferred `mcp` attachment).
- Prove the full claims path (token → authorizer → `event.requestContext.
authorizer.claims` → handler) with a `whoami` endpoint, not just Pulumi
  resources that nothing ever calls.
- Land the `share_grants` table shape and the ownership/grant predicate as a
  pattern in `shared` that the transaction-store change (next) can adopt
  without redesigning it.

**Non-Goals:**

- No login UI or `scope:web` package — Amplify Auth wiring in this change is
  the library dependency declaration and the contract it must satisfy, not a
  working client.
- No real user-owned business table. `share_grants` is real (it's the
  mechanism itself), but nothing in `accounts`/`categories`/transactions
  shape is created here.
- No resolution of the MCP client-registration/OAuth-for-Claude-Desktop
  question — ADR-0002 explicitly defers that to its own ADR.
- No `mcp` authorizer attachment, and no "one token authorizes both API
  surfaces" requirement in this change's delta spec. `mcp`'s REST API was
  never actually provisioned in Pulumi (ADR-0001 left it as an open action
  item), so there is nothing to attach an authorizer to yet. That requirement
  belongs to the future change that provisions `mcp`'s base API — asserting
  it here, in a change that only wires `ingestion`'s side, would leave the
  capability spec claiming behavior this change does not deliver.

## Decisions

**1. New API Gateway REST API in `ingestion`, not a route added to `mcp`.**
Alternative considered: add `/whoami` as another route on MCP's existing
authorizer-protected API, avoiding a second API Gateway resource entirely.
Rejected per the resolved scope decision above — ADR-0002 treats "primary
app API" and "MCP API" as two separate surfaces by design (different
protocols, different Lambda code, different deploy lifecycles), and folding
whoami into `mcp` would make the primary app's only proven endpoint live
inside the MCP surface, which misrepresents what's being tested.

**2. `share_grants` and the predicate helper live in `shared`, not
`ingestion`.** Both `ingestion` and (eventually) `mcp` need to issue the same
`WHERE owner_user_id = :sub OR EXISTS (...)` predicate against tables they
each query. Per `module-boundary-enforcement`, `ingestion` and `mcp` cannot
depend on each other, so anything both need belongs in `shared` — this is
exactly the boundary rule the spec already states, not a new exception.

**3. No ORM/query-builder introduced for the predicate.** The predicate is
expressed as a hand-written SQL fragment/helper in `shared` that callers
splice into their own queries, rather than a query-builder abstraction that
tries to inject it automatically. At two users and a handful of tables, an
automatic-injection layer is exactly the kind of premature machinery
ADR-0002's Trade-off Analysis warns against for the permissions-caching
question — same reasoning applies to over-abstracting the predicate itself.
A future change can revisit this if the number of query sites makes manual
inclusion error-prone.

**4. Pre-Sign-Up allowlist as Lambda env var, not a config table.** Matches
ADR-0002 decision #3 directly: two emails, unlikely to change often, and a
DB round-trip from a Pre-Sign-Up trigger (which runs before the user even
has a profile) adds a dependency for no benefit at this scale.

**5. `whoami` returns claims only, touches no database.** Keeps this change
provable independent of any schema decision the transaction-store change
will make. The endpoint reads `event.requestContext.authorizer.claims`
directly and echoes `sub`/`email` back — no query, no table.

**6. One explicit `aws.Provider` for `infra`, with `Environment` derived from
`pulumi.getStack()` rather than typed per stack.** `aws:defaultTags` as plain
stack config can't hold a computed value, so a manually-set `Environment` tag
per stack risks drift (wrong value entered, or forgotten entirely on a new
stack). `infra/lib/provider.ts` instead builds one `aws.Provider` with
`Project`/`ManagedBy` constants plus `Environment: pulumi.getStack()`, and
every resource in `cognito.ts`/`ingestionApi.ts` passes `{ provider }`
explicitly. The API Gateway stage name follows the same rule
(`stageName: pulumi.getStack()`, not a hardcoded `'prod'`), so a `dev` stack
deploy doesn't produce a stage labeled `prod`.

## Risks / Trade-offs

- **Manual predicate inclusion can be forgotten at a new query site** →
  Mitigated the same way ADR-0002 already commits to: a lint/review
  checklist item (tracked as a task in this change) flags any new query
  against a user-owned table that doesn't include the predicate. This is a
  process mitigation, not a technical one — accepted as adequate at current
  scale per Decision 3.
- **A future `mcp` authorizer could hardcode or re-derive the pool ARN instead
  of referencing this stack's export** → once `mcp` gets its own REST API
  (not part of this change — see Non-Goals), a hardcoded/stale ARN there
  would silently split auth behavior between the two surfaces. This change's
  pool ARN is already exported (`userPoolArn` in `infra/index.ts`) specifically
  so that future change imports it rather than re-deciding it.
- **Allowlist-in-env-var doesn't scale past a handful of users** → acceptable
  now; ADR-0002's own action items already flag revisiting this if a third
  user is ever added, and moving from env var to a small config table is a
  contained, low-risk follow-up when that happens.
- **A new resource added to `infra` that forgets to pass `{ provider }`
  silently escapes the standard tags and (if it read region another way)
  could target the wrong region** → same category of risk as Decision 3's
  predicate-omission concern, and mitigated the same way: this is a review
  checklist item, not a technical guardrail, at the current resource count.

## Migration Plan

- Additive only: new Cognito resources, new `ingestion` API Gateway REST
  API, new `share_grants` table. Nothing existing changes shape.
- Deploy order: Cognito User Pool + Pre-Sign-Up trigger first (must exist
  before anyone can sign in), then `ingestion`'s authorizer attachment, then
  the `whoami` route and `share_grants` table. No traffic depends on any of
  this today, so there is no cutover step and no rollback beyond `pulumi
destroy` on the newly-added resources.
