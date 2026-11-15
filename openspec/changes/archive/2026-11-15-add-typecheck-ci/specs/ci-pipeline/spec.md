## MODIFIED Requirements

### Requirement: CI runs install, lint, build, and test on every PR
The GitHub Actions workflow SHALL trigger on pull requests and run, in order: dependency
install, lint (via `nx affected -t lint`), type-check (via `nx affected -t typecheck`), build
(via `nx affected -t build`), and test (via `nx affected -t test`). The workflow SHALL fail if
any step fails. Every project SHALL have a `typecheck` target that checks both its source and
its spec files without emitting output.

#### Scenario: Trivial PR passes CI
- **WHEN** a pull request is opened that only touches the generated stub projects with no
  boundary violations
- **THEN** the workflow run completes with install, lint, type-check, build, and test all
  reporting success

#### Scenario: Boundary violation fails CI
- **WHEN** a pull request introduces a disallowed cross-scope import (e.g. `scope:mcp`
  importing `scope:ingestion` internals)
- **THEN** the workflow's lint step fails and the overall run is reported as failed

#### Scenario: Type error fails CI
- **WHEN** a pull request introduces a type error in any project's source or spec files,
  including one in a project that is bundled without type checking
- **THEN** the workflow's type-check step fails and the overall run is reported as failed

#### Scenario: Shared change re-checks dependents
- **WHEN** a pull request changes `shared` in a way that breaks the types of a project that
  depends on it
- **THEN** that dependent project's type-check runs in the same workflow and fails
