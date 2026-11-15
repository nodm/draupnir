# draupnir

Personal finance tool for two users. Bank statement CSVs are sent to a Telegram bot,
stored in S3, imported by an SQS-triggered Lambda into Aurora PostgreSQL (RDS Data API,
row-level security), and exposed to Claude through a remote MCP server
(`https://mcp.draupnir.nodm.name/mcp`). AWS, Pulumi, Nx + pnpm monorepo, TypeScript.

## Layout

| Project      | What                                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/`    | Library used by everything: `dataApi.ts` (`withCaller`), `membership.ts` (`memberPredicate`), `dataTools/` (tools served over MCP), `migrations/`, `testing/` |
| `ingestion/` | Statement import Lambda: `parsers/` (one per bank, fixtures in `__fixtures__/`), `validation/`, `processStatementFile.ts`, `rebuildAccount.ts`                |
| `bot/`       | Telegram Lambdas: webhook (enqueue only), worker, Google sign-in callback, retention job                                                                      |
| `mcp/`       | MCP server Lambda + OAuth endpoints                                                                                                                           |
| `infra/`     | Pulumi program (`index.ts`, `lib/*`); stack `prod`                                                                                                            |

Every app may depend only on `shared` (enforced by `@nx/enforce-module-boundaries` via `scope:*` tags).

## Commands

```bash
pnpm exec nx run-many -t lint typecheck test build   # whole repo
pnpm exec nx affected -t lint typecheck test build   # what CI runs on PRs
pnpm exec nx test ingestion                          # one project
pnpm exec nx format:write --all                      # format; CI runs format:check --all
```

- Database tests run real migrations in pglite (in-memory Postgres, CPU-heavy). `test`
  targets never run alongside other tasks (`parallelism: false` in `nx.json`), because
  several projects' pglite workers at once overload the CPU and setup hooks time out.
  Keep it that way.
- Run `pulumi` commands from `infra/`, and only through the Nx targets
  (`infra:preview`); they build the Lambda bundles first.

## Rules

### Production

- **Prod holds real bank data that cannot be re-created.** Never run `infra:up`,
  `infra:destroy`, `infra:reset-data`, `pulumi up/destroy`, or write SQL / `aws s3 rm`
  against prod unless the user explicitly asks. The user normally runs deploys themselves.
- Deploy only from an up-to-date `main`: deploying a branch that lacks newer infra
  deletes that infra.
- Before any deploy, read `infra:preview` for replaces/deletes of data stores (Aurora,
  buckets, queues).
- Any change under `shared/` redeploys every Lambda and re-runs the `migrate-database`
  invocation.

### Database

- Migrations live in `shared/src/lib/migrations/`, are append-only (never edit an
  applied one), and must be additive / backward compatible. Register new ones in
  `migrations.ts`.
- Every new table needs `ENABLE ROW LEVEL SECURITY` and policies (a guard test fails
  otherwise). `SECURITY DEFINER` functions pin `search_path = pg_catalog, pg_temp`,
  schema-qualify references, and revoke `EXECUTE` from `PUBLIC`.
- Application DB access goes through `withCaller(client, config, sub, fn)`; outside it
  RLS returns nothing. Queries on member-owned rows use `memberPredicate`.
- RDS Data API SQL parser: no backslashes in SQL literals (use `ESCAPE '!'` for `LIKE`).
- A schema change must update `docs/data-model.md` in the same change;
  `shared/src/lib/dataModelDoc.spec.ts` fails otherwise.

### Lambdas and infra

- esbuild Lambda targets bundle dependencies (`thirdParty: true`) and keep `@aws-sdk/*`
  external. `mcp` also keeps `@modelcontextprotocol/*` external; `mcp:install-deps`
  installs them into `dist/mcp`.
- New Lambdas go through `createLambdaFunction` (`infra/lib/lambdaFunction.ts`) so they
  get a log group with retention. New AWS resources pass `{ provider }` (the one
  shared `aws.Provider` from `createAwsProvider`, `infra/lib/provider.ts`) for tags and region.
- DB-backed API routes need the 29 s timeout (API Gateway REST ceiling), not the default.

### Adding a bank

Touch, with tests: `ingestion/src/lib/parsers/<bank>.ts` + fixture CSV,
`ingestion/src/lib/validation/formats.ts` and `validateStatement.ts`,
`ingestion/src/lib/derive.ts`, `ingestion/src/lib/dedupKey.ts`, a migration adding the
bank, `shared/src/lib/transactionsSchema.ts`, `bot/src/lib/accounts/format.ts`,
`docs/data-model.md`. Reference: PR #93 (PrivatBank).

## Workflow

- Feature work goes through OpenSpec: `/opsx:propose` → `/opsx:apply` → `/opsx:archive`.
  Current specs: `openspec/specs/`; active changes: `openspec/changes/`.
- Branches `nodm/<name>`; Conventional Commits; PR template has a security checklist.
- Prettier skips `openspec/` and tool-generated skills/commands (`.prettierignore`); don't
  format them by hand either.

## Docs

- `docs/architecture.md`: AWS resources diagram
- `docs/data-model.md`: every table and function
- `docs/telegram-bot.md`: bot setup, user guide, troubleshooting
- `docs/adr/`: decisions (ADR-0011 is reserved for `add-bot-ai-chat`)
- `infra/README.md`: stack config, deploying, guardrails, alerts runbook

<!-- nx configuration start-->
<!-- Leave the start & end comments to automatically receive updates. -->

# General Guidelines for working with Nx

- For navigating/exploring the workspace, invoke the `nx-workspace` skill first - it has patterns for querying projects, targets, and dependencies
- When running tasks (for example build, lint, test, e2e, etc.), always prefer running the task through `nx` (i.e. `nx run`, `nx run-many`, `nx affected`) instead of using the underlying tooling directly
- Prefix nx commands with the workspace's package manager (e.g., `pnpm nx build`, `npm exec nx test`) - avoids using globally installed CLI
- You have access to the Nx MCP server and its tools, use them to help the user
- For Nx plugin best practices, check `node_modules/@nx/<plugin>/PLUGIN.md`. Not all plugins have this file - proceed without it if unavailable.
- NEVER guess CLI flags - always check nx_docs or `--help` first when unsure

## Scaffolding & Generators

- For scaffolding tasks (creating apps, libs, project structure, setup), ALWAYS invoke the `nx-generate` skill FIRST before exploring or calling MCP tools

## When to use nx_docs

- USE for: advanced config options, unfamiliar flags, migration guides, plugin configuration, edge cases
- DON'T USE for: basic generator syntax (`nx g @nx/react:app`), standard commands, things you already know
- The `nx-generate` skill handles generator discovery internally - don't call nx_docs just to look up generator syntax

<!-- nx configuration end-->
