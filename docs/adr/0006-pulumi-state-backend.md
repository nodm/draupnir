# ADR-0006: Pulumi State Backend

## Status

Accepted

## Date

2026-08-29

## Deciders

Dmytro Novikov

## Context

`infra/` (`draupnir-infra`, Pulumi TypeScript) has resources landing per
[ADR-0005](./0005-aws-region-selection.md) but no stack has been initialized yet
(no `Pulumi.<stack>.yaml`) — the state backend has to be picked before `pulumi up`
can run for the first time. Pulumi state (resource URNs, outputs, secrets) has to
live somewhere durable; the backend is a login-time choice (`pulumi login
<backend>`), not per-resource config.

Single AWS account, single stack (`prod`), Dmytro is the sole deployer/maintainer
across this and future personal projects — no team access-control requirement to
design for, and a preference to own the storage rather than depend on a
third-party SaaS.

### Candidates

1. **Pulumi Cloud, Individual tier** — Pulumi's own managed SaaS backend
   (`pulumi login` with no args). Free forever for a single user, no card
   required: managed state storage, encrypted secrets (key managed server-side,
   no passphrase/KMS to configure), deployment history, web UI.
2. **Self-managed S3 backend, shared across projects** — `pulumi login
s3://<bucket>/<project>/<stack>`, one bucket in this AWS account reused across
   all of Dmytro's Pulumi projects, not just this one.
3. **Local file backend** — `pulumi login file://~` (Pulumi's default with no
   login at all). State lives as files under `~/.pulumi`.

An earlier draft of this ADR picked option 1, treating the S3 bucket's manual
bootstrap as a recurring cost of self-hosting. That framing was wrong: the bucket
is provisioned **once**, ever — every future project just adds a new prefix to
the same bucket. Re-evaluated below with that corrected.

## Decision

**Use a self-managed S3 backend, with an AWS KMS key as the secrets provider —
not a bare passphrase.**

- `pulumi login s3://nodm-pulumi-state/draupnir` — one bucket (`nodm-pulumi-state`,
  eu-north-1), reused by future projects under their own prefix. If that bucket
  name is already taken globally when actually created, fall back to
  `nodm-pulumi-state-<account-id>` (account ID suffix guarantees uniqueness).
- `pulumi stack init prod --secrets-provider="awskms://alias/nodm-pulumi-state?region=eu-north-1"` —
  a dedicated, shared personal-projects KMS key (alias `nodm-pulumi-state`)
  encrypts stack secrets. The `?region=eu-north-1` query parameter is required,
  not optional decoration: this command runs before any stack config (including
  `aws:region` from ADR-0005) exists, so without it the alias resolves against
  whatever region the local AWS SDK defaults to on that machine — which can
  differ from where the key actually lives. Passphrase was rejected: a self-managed passphrase that's lost makes
  every encrypted secret in every stack's state unrecoverable, with no recovery
  path. KMS moves that custody risk onto a resource that can be backed up,
  IAM-controlled, and (per AWS docs) is deletion-protected with a mandatory
  waiting period rather than deletable instantly.
  ([Pulumi: Secrets Handling](https://www.pulumi.com/docs/iac/concepts/secrets/))

## Options Considered

| Option                             | Setup                                                                 | Durability                                                           | Ops burden                          | Cost                                                                     | Notes                                                                             |
| ---------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| **Self-managed S3 + KMS — chosen** | One-time bucket + KMS key provisioning, reused by all future projects | As durable as the bucket is configured (versioning)                  | Owns bucket/key IAM, KMS key backup | ~€1/mo (KMS key flat fee; S3 storage/requests round to $0 at this scale) | Fully owned, no third-party SaaS dependency                                       |
| Pulumi Cloud, Individual           | `pulumi login`, no infra                                              | Managed by Pulumi, off-machine                                       | None                                | Free (single user)                                                       | Third-party SaaS holds state; loses appeal once "I own it" is a stated preference |
| Local file (`file://~`)            | None — Pulumi's default                                               | Single machine, no backup unless `~/.pulumi` is backed up separately | None enforced                       | Free                                                                     | Losing the machine/directory loses state with no recovery path                    |

## Trade-off Analysis

- **Why the bootstrap objection from the earlier draft doesn't hold**: it only
  bites once, when the shared bucket is first created — not per project. Once it
  exists, every future Pulumi project (not just `draupnir-infra`) reuses it under
  a new prefix, so the one-time setup amortizes indefinitely. That's the fact
  that flipped this decision from ADR-0006's original Pulumi Cloud pick.
- **Passphrase vs. KMS for the secrets provider**: passphrase is free and needs
  no extra AWS resource, but the custody risk is absolute — losing the passphrase
  (no password-manager entry, no backup) permanently loses every secret encrypted
  under it, including DB credentials that will live in this state per
  [ADR-0003](./0003-aurora-access-pattern.md). KMS costs **~€1/mo flat** per key
  (eu-north-1, prorated hourly) plus request charges that stay inside the
  20,000/mo free tier at solo, non-CI usage levels.
  ([AWS KMS pricing](https://aws.amazon.com/kms/pricing/)) At that price, buying
  out the "I lost the one secret that unlocks everything" failure mode is an easy
  call — not a cost worth optimizing away.
- **Why not Pulumi Cloud, now that the bootstrap cost is correctly understood as
  one-time**: its only real advantages over self-managed S3 are convenience
  (zero setup) and features Dmytro doesn't need solo (web UI, deployment history,
  RBAC). Against a stated preference to own state rather than depend on
  Pulumi's SaaS, and a true cost of ~€1/mo, self-managed S3+KMS wins on the axis
  that actually matters here.
- **Why not local file backend**: unchanged from the earlier draft — a single
  laptop with no backup is a single point of failure for the only record of
  what's deployed. Never the standing choice once real infrastructure exists.

## Consequences

- One-time setup before first use, shared across all future projects: create the
  S3 bucket (versioning + default encryption enabled) and a KMS key, once.
  `draupnir-infra` uses `s3://nodm-pulumi-state/draupnir` as its state prefix and
  `awskms://alias/nodm-pulumi-state` as its secrets provider.
- Deploying no longer depends on Pulumi Cloud's availability — only on this AWS
  account (S3 + KMS), which is already the trust boundary for everything else in
  this project.
- No Pulumi Cloud web UI / deployment history / stack-readiness view. Acceptable
  solo; revisit if a collaborator ever needs shared visibility.
- Ongoing cost: **~€1/mo**, entirely the KMS key's flat fee — S3 storage and
  request costs round to $0 at this state size and call volume.
- The bucket and KMS key are **not** managed by the `draupnir-infra` Pulumi stack
  itself (the chicken-and-egg problem this ADR's earlier draft was originally
  worried about) — they're bootstrapped once, out-of-band, before `pulumi login`
  can even target them.

## Action Items

- [x] Create bucket `nodm-pulumi-state` (eu-north-1, versioning + default
      encryption on) and KMS key alias `alias/nodm-pulumi-state`, once,
      out-of-band (console or a one-off script — not the `draupnir-infra` stack
      itself).
- [ ] `pulumi login s3://nodm-pulumi-state/draupnir`, then `pulumi stack init
    prod --secrets-provider="awskms://alias/nodm-pulumi-state?region=eu-north-1"` before the
      first `pulumi up`.
- [x] Store the bucket name and KMS key ARN somewhere durable outside Pulumi
      state itself — see [infra/README.md](../../infra/README.md).
- [ ] Revisit if a collaborator other than Dmytro needs stack access/visibility —
      Pulumi Cloud's RBAC and web UI become relevant at that point.
