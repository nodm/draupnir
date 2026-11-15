## 1. Check the spec against the code

- [x] 1.1 Verify `nx show projects` lists exactly `ingestion`, `bot`, `mcp`, `shared`, `infra` with the tags in the spec (read from each `project.json`)
- [x] 1.2 Verify the `bot`, `ingestion` and `mcp` build targets use `@nx/esbuild:esbuild` with `@aws-sdk/*` external, and `mcp` also `@modelcontextprotocol/*` (read from each `project.json`)
- [x] 1.3 Verify `openspec validate fix-monorepo-workspace-spec` passes

## 2. Archive

- [ ] 2.1 After merge, archive the change and set the main spec's Purpose to the current layout; verify `openspec validate monorepo-workspace --type spec` passes
