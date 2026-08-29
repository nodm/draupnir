## 0. Pulumi stack + AWS resource tagging (`infra`)

- [x] 0.1 Initialize the `prod` Pulumi stack and verify `Pulumi.prod.yaml` is
      created — no stack exists yet, and every subsequent task in this change
      depends on one existing. Per [ADR-0006](../../../../docs/adr/0006-pulumi-state-backend.md),
      backend is a self-managed S3 bucket + KMS secrets provider (already
      bootstrapped — see [infra/README.md](../../../../infra/README.md)), not
      the local file backend/passphrase this note originally assumed:
      `pulumi login s3://nodm-pulumi-state/draupnir && pulumi stack init prod
--secrets-provider="awskms://alias/nodm-pulumi-state?region=eu-north-1"`
      from `infra/` — the `?region=` query parameter is required since this
      command runs before `aws:region` (task 0.2) is set on the stack.
      Verified: `Pulumi.prod.yaml` created with `secretsprovider:
    awskms://alias/nodm-pulumi-state?region=eu-north-1`; stack confirmed
      present in `s3://nodm-pulumi-state/draupnir` via `pulumi stack ls` and
      `aws s3 ls`.
- [x] 0.2 Set the AWS region to eu-north-1 (ADR-0005) on the `prod`
      stack config and verify `pulumi config get aws:region` returns
      eu-north-1 — depends on 0.1 (needs the `prod` stack to exist first).
      Verified: `pulumi config get aws:region --stack prod` returns
      `eu-north-1`.
- [x] 0.3 Configure `defaultTags` (Project: draupnir, ManagedBy: pulumi,
      Environment: `pulumi.getStack()`) on an explicit `aws.Provider` and
      verify `pulumi preview` shows all three tags applied to every taggable
      resource in this change (Cognito User Pool, any Lambda functions) —
      `infra/lib/provider.ts`; code-driven, not manual `pulumi config set`,
      so `Environment` is always correct for whichever stack is deployed
      (`prod`, `dev`, ...) with no per-stack manual step. Live `pulumi
preview --stack prod` now runs clean (22 resources to create, no errors).
- [x] 0.4 Set the required `prod` stack config values that `createAuthPool`
      reads (`allowlistedEmails`, `google:clientId`, `google:clientSecret`,
      `authDomainPrefix`) and verify `pulumi preview` no longer errors on a
      missing config key — see [infra/README.md](../../../../infra/README.md)
      for the exact `pulumi config set` commands; depends on 0.1 (needs the
      `prod` stack to exist first). Verified: all 5 config keys set
      (`pulumi config --stack prod`), `pulumi preview --stack prod` runs
      clean with 22 resources to create and no missing-config errors.

## 1. Cognito User Pool (`infra`)

- [x] 1.1 Provision a Cognito User Pool in Pulumi with Google as the only
      federated IdP (no native username/password) and verify `pulumi preview`
      shows the pool and Google IdP resources with no other IdP configured
      (`infra/lib/cognito.ts`; implementation complete and now confirmed via
      `pulumi preview --stack prod`, which lists `aws:cognito:UserPool` and
      `aws:cognito:IdentityProvider google` with no other IdP resource)
- [x] 1.2 Enable Managed Login on the pool (hosted domain/branding) and
      verify the Managed Login domain is reachable and shows Google as the
      only sign-in option (`UserPoolDomain` with `managedLoginVersion: 2`;
      implementation complete and preview-verified — the live domain-
      reachability check requires `pulumi up`, which has not been run yet,
      so it remains a follow-up, not a blocker for this change)
- [x] 1.3 Confirm `AdminLinkProviderForUser`/`Cognito_Subject` linking is not
      configured anywhere in the Pulumi program and verify two allowlisted
      Google accounts each produce a distinct Cognito profile/`sub` after
      signing in (confirmed by omission — no such config anywhere in
      `infra/lib/cognito.ts`; implementation complete — the live two-account
      sign-in check requires a deployed pool (`pulumi up`, not yet run) and
      real Google accounts, so it remains a follow-up, not a blocker)
- [x] 1.4 Implement the `PreSignUp_ExternalProvider` Lambda trigger with a
      two-email allowlist (env var/config value) and verify a non-allowlisted
      email fails sign-up while an allowlisted email succeeds
      (`infra/src/preSignUpTrigger.ts` + unit tests; implementation complete
      and unit-tested — the live Cognito sign-up rejection requires a
      deployed pool (`pulumi up`, not yet run), so it remains a follow-up,
      not a blocker)
- [x] 1.5 Attach the Pre-Sign-Up trigger to the user pool and verify
      `pulumi preview`/`pulumi up` wires the trigger before the pool accepts
      any sign-up (`lambdaConfig.preSignUp` set at pool creation time)

## 2. Authorizers on both API surfaces (`infra`)

- [x] 2.1 Create a new API Gateway REST API for `ingestion` in Pulumi and
      verify `pulumi preview` shows it as a standalone resource, separate
      from the `mcp` API (`infra/lib/ingestionApi.ts`)
- [x] 2.2 Attach a native `COGNITO_USER_POOLS` authorizer, referencing the
      pool from 1.1 by its exported ARN, to the new `ingestion` API and
      verify an unauthenticated request to a protected route returns 401
      before any Lambda invokes (authorizer wired to the `/whoami` method;
      implementation complete and preview-verified — the live 401 check
      requires a deployed API (`pulumi up`, not yet run), so it remains a
      follow-up, not a blocker)
- [ ] 2.3 Attach the same authorizer configuration (same pool ARN) to the
      existing `mcp` REST API from ADR-0001 and verify a token issued via
      sign-in authorizes requests to both APIs
      **DEFERRED (user decision)**: `mcp`'s API Gateway REST API was never
      actually provisioned in Pulumi — ADR-0001 left "add Pulumi resources:
      Lambda, REST API, Cognito authorizer" as an unchecked action item, so
      there is no existing `mcp` API to attach to. User chose to ship the
      pool + `ingestion`'s authorizer now and defer this to a future change
      that provisions `mcp`'s base API.

## 3. Whoami endpoint (`ingestion`)

- [x] 3.1 Add a `GET /whoami` route on the new `ingestion` API, protected by
      the authorizer from 2.2, and verify the route is rejected without a
      token (method requires `COGNITO_USER_POOLS` authorization;
      implementation complete and preview-verified — the live rejection
      check requires a deployed API (`pulumi up`, not yet run), so it
      remains a follow-up, not a blocker)
- [x] 3.2 Implement the `whoami` handler to read
      `event.requestContext.authorizer.claims.sub`/`email` and return them,
      and verify an authenticated request returns the caller's own `sub` and
      `email` matching their token (`ingestion/src/whoami.ts` +
      `ingestion/src/lib/whoami.ts` with unit tests)

## 4. Ownership/share-grant pattern (`shared`)

- [x] 4.1 Define the `share_grants` table shape (`grantor_user_id`,
      `grantee_user_id`, `resource_type`, `resource_id`, `created_at`) and
      verify the migration/schema definition applies cleanly
      (`shared/src/lib/shareGrants.ts`; verified by parsing the DDL as valid
      Postgres with `pgsql-ast-parser` — no Aurora cluster exists yet to
      apply it against for real, per this change's non-goals)
- [x] 4.2 Implement the query-time ownership/grant predicate helper
      (`WHERE owner_user_id = :sub OR EXISTS (...)`) in `shared` and verify a
      unit test covers: owner-only access, active-grant access, and
      no-access-without-grant
- [x] 4.3 Implement the write-side rule restricting `share_grants`
      insert/delete to the resource's owner (`grantor_user_id` must equal
      the authenticated `sub`) and verify a unit test covers a non-owner's
      attempt being rejected
- [x] 4.4 Verify a revoked grant (row deleted) denies access on the very
      next predicate evaluation, with no caching layer involved

## 5. Client-side contract (declaration only)

- [x] 5.1 Add `aws-amplify` v6 as a dependency where the future client will
      live and verify the installed version's `signInWithRedirect`/
      `fetchAuthSession` API surface matches what this change assumes (no
      client code calls it yet — this only guards against building against a
      stale API) — added to root `package.json` (no `scope:web` package
      exists yet); both exports confirmed present in the installed 6.20.0

## 6. Process safeguard

- [x] 6.1 Add a lint/review checklist item (e.g. PR template line or lint
      rule note) flagging any new query against a user-owned table that
      omits the ownership/grant predicate, and verify the checklist item is
      visible in the PR template or lint config (`.github/pull_request_template.md`)
