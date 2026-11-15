## Context

Each app project has `tsconfig.lib.json` (source) and `tsconfig.spec.json` (specs) referenced from a non-composite `tsconfig.json`; `infra` has `tsconfig.json` (source) and `tsconfig.spec.json`. `infra:build` already runs `tsc --noEmit` on its source, the other builds don't type-check at all.

## Goals / Non-Goals

**Goals:** one target name across projects, cached, re-run when a dependency changes.

**Non-Goals:** switching to TypeScript project references / `tsc --build`; changing `target` or emitted code.

## Decisions

1. **Explicit `nx:run-commands` targets over the inferred `@nx/js/typescript` plugin.** The plugin infers `typecheck` from a project-references setup (`composite`, `tsc --build`), which this workspace doesn't use; adopting it would mean restructuring every tsconfig. Two `tsc --noEmit -p …` commands per project need no restructuring.
2. **Cache and inputs in `nx.json` `targetDefaults`** (`cache: true`, inputs `default` + `^default`), so the per-project entries only list commands and a `shared` edit invalidates its dependents.
3. **`lib` ES2024, `target` unchanged.** `lib` only decides which built-ins type-check; every Lambda runtime is `nodejs24.x`, which has them (`Map.groupBy`). esbuild decides the emitted syntax, so `target` stays as is.
4. **Fix casts instead of widening them.** `run()` already returns typed results; removing `as Record<string, unknown>[]` lets the specs check field names, where `as unknown as` would hide them.

## Risks / Trade-offs

- [A future Lambda on an older runtime could use an ES2024 built-in that type-checks but is missing at runtime] → the runtime is set in `infra/lib/*`; raise `lib` only with the runtime.
- [CI takes longer: one more `tsc` pass per affected project] → cached, and only affected projects run.
