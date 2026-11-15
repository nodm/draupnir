## 1. Remove the BDD stub

- [x] 1.1 Delete `ingestion/features/` and the `bdd` target in `ingestion/project.json`; verify `nx show project ingestion` lists no `bdd` target
- [x] 1.2 Remove `@cucumber/cucumber` from the root `package.json` and update the lockfile; verify `pnpm install --frozen-lockfile` succeeds and nothing else imports it
- [x] 1.3 Verify `nx run-many -t lint typecheck test build` and `nx format:check --all` pass
