## 1. Ignore list and one-time format

- [x] 1.1 Add `openspec/`, tool-generated skill/command folders, `pnpm-lock.yaml` and `-temp-/` to `.prettierignore`; verify `prettier --check .` lists only real source and docs files
- [x] 1.2 Format the remaining files; verify `prettier --check .` passes twice in a row (idempotent) and `nx run-many -t lint typecheck test` passes, including the `docs/data-model.md` doc test

## 2. CI and docs

- [x] 2.1 Add `nx format:check --all` before lint in `.github/workflows/ci.yml`; verify it exits 1 on an unformatted probe file under `bot/src` and under `docs/`, 0 when clean, and passes on the PR
- [x] 2.2 List `nx format:write --all` in the `AGENTS.md` commands and replace the "don't run Prettier over openspec/" note; verify by reading the file
