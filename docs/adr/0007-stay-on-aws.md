# ADR-0007: Stay on AWS (vs. Supabase / Supabase + Cloudflare)

## Status

Accepted

## Date

2026-11-03

## Deciders

Dmytro Novikov

## Context

The stack is AWS end to end: Aurora Serverless v2 (PostgreSQL) behind RDS Data API
([ADR-0003](./0003-aurora-access-pattern.md)), Lambda + API Gateway
([ADR-0001](./0001-mcp-transport.md)), Cognito ([ADR-0002](./0002-auth-request-flow.md)),
Pulumi state in S3 + KMS ([ADR-0006](./0006-pulumi-state-backend.md)). The next
changes (`add-db-migrations`, `redesign-statement-data-model`,
`add-row-level-security`, `add-telegram-bot`, `add-bot-ai-chat`) add schema, roles,
and policies on top of it, so this is the point to confirm the platform before more
code depends on it.

Two alternatives were raised:

1. **Current AWS stack** — Aurora (scale-to-zero), Lambda, API Gateway, Cognito.
2. **Supabase free tier** — managed Postgres with RLS/JWT wiring, Google auth,
   storage, and edge functions in one product.
3. **Supabase + Cloudflare** — Supabase for Postgres/auth, Cloudflare Workers for
   compute (MCP endpoint, Telegram webhook), Email Workers, and R2 for statement
   files.

## Decision

**Stay on AWS.**

RLS is plain Postgres: the `add-row-level-security` change is written against
Aurora and stays portable, so staying does not close the door on moving the
database later.

## Options Considered

| Option                   | Idle cost                                         | Auth                   | RLS / Postgres       | Backups                  | Lock-in | Learning value (SAA) |
| ------------------------ | ------------------------------------------------- | ---------------------- | -------------------- | ------------------------ | ------- | -------------------- |
| **Current AWS — chosen** | Near zero (scale-to-zero, no NAT, no VPC Lambdas) | Cognito (built)        | Plain Postgres       | Aurora automated backups | Medium  | High                 |
| Supabase free tier       | $0                                                | Built-in, incl. Google | Plain Postgres + JWT | None on free tier        | Low     | Low                  |
| Supabase + Cloudflare    | $0 (free plans), $25/mo Pro for backups           | Supabase               | Plain Postgres + JWT | None on free tier        | Low     | Low                  |

## Trade-off Analysis

- **Learning goal.** The stack doubles as AWS Solutions Architect Associate practice
  (VPC, IAM, Data API, Cognito, Lambda, Pulumi). Moving to Supabase/Cloudflare
  discards that without a compensating gain.
- **Cost is already near zero.** Aurora scales to zero after 300s idle, there is no
  NAT gateway, and no Lambda is in the VPC. Real monthly bill (Cost Explorer):
  **TODO(Dmytro): fill in `€__ / month`** — the revisit threshold below depends on it.
- **Supabase pros:** RLS with JWT wiring out of the box, Google auth built in, plain
  Postgres, low lock-in. **Cons:** free tier has no backups, projects pause after 7
  days of inactivity, Pro is $25/mo, no SLA on free.
- **Cloudflare pros:** free Workers, an MCP OAuth library, Email Workers, R2.
  **Cons:** free-plan CPU time limit, non-Node runtime, a second vendor to operate.
- **Switching cost.** Cognito, Lambda handlers, Pulumi infra, and the Data API access
  layer are already built and tested; a move means rewriting all of them to save
  little.

## Consequences

- Schema is managed by an in-repo migration runner over RDS Data API
  (`add-db-migrations`) instead of Supabase's migration tooling.
- RLS is adopted on Aurora in a later change, using plain Postgres features only, to
  keep a future move cheap.
- Neither Supabase nor Cloudflare accounts are needed.

## Action Items

- [ ] Fill in the real monthly bill from Cost Explorer in Trade-off Analysis.
- [ ] Revisit if the SAA learning goal ends, or the monthly bill exceeds an agreed
      threshold (set one when the bill above is filled in).
