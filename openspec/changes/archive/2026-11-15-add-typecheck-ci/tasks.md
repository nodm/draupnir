## 1. Fix existing type errors

- [x] 1.1 Raise `tsconfig.base.json` `lib` to ES2024 and verify `tsc --noEmit -p shared/tsconfig.spec.json` no longer reports `Map.groupBy`
- [x] 1.2 Drop the casts in `shared/src/lib/dataTools/dataTools.spec.ts` and narrow create-table columns in `shared/src/lib/transactionsSchema.spec.ts`; verify `nx test shared` passes

## 2. Typecheck target and CI

- [x] 2.1 Add `targetDefaults.typecheck` (cached, `default` + `^default` inputs) to `nx.json` and a `typecheck` target to every `project.json`; verify `pnpm exec nx run-many -t typecheck` passes for all 5 projects
- [x] 2.2 Add the `nx affected -t typecheck` step between lint and build in `.github/workflows/ci.yml`; verify the PR's CI run shows it passing
- [x] 2.3 List `typecheck` in the `AGENTS.md` commands; verify by reading the file
