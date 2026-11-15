## Why

`bot`, `ingestion` and `mcp` are bundled with esbuild, which strips types without checking them, and no project had a type-check target. CI therefore passed while `shared`'s specs held 6 type errors, and an agent or reviewer reading a green run had no signal that types were broken.

## What Changes

- Every project gets a `typecheck` target that type-checks its source and its specs without emitting; results are cached, and a change in `shared` re-checks the projects that depend on it.
- CI runs the affected projects' `typecheck` between lint and build; a type error fails the run.
- The existing errors are fixed: the base TypeScript `lib` moves from ES2020 to ES2024 (every Lambda runs Node.js 24, which provides it) and two specs drop casts / narrow a union.
- `AGENTS.md` lists `typecheck` in the standard commands.

## Capabilities

### New Capabilities
(none)

### Modified Capabilities
- `ci-pipeline`: the PR gate adds a type-check step between lint and build.

## Impact

- `nx.json` (`targetDefaults.typecheck`), each `*/project.json`, `.github/workflows/ci.yml`.
- `tsconfig.base.json` (`lib`), `shared/src/lib/dataTools/dataTools.spec.ts`, `shared/src/lib/transactionsSchema.spec.ts`.
- `AGENTS.md`.
- No runtime or deployed-code change.
