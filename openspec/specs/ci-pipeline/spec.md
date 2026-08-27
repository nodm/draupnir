# ci-pipeline Specification

## Purpose

Gives every pull request an automated install/lint/build/test gate so a boundary violation
or broken stub is caught in CI, not after merge.

## Requirements

### Requirement: CI runs install, lint, build, and test on every PR
The GitHub Actions workflow SHALL trigger on pull requests and run, in order: dependency
install, lint (via `nx affected -t lint`), build (via `nx affected -t build`), and test (via
`nx affected -t test`). The workflow SHALL fail if any step fails.

#### Scenario: Trivial PR passes CI
- **WHEN** a pull request is opened that only touches the generated stub projects with no
  boundary violations
- **THEN** the workflow run completes with install, lint, build, and test all reporting
  success

#### Scenario: Boundary violation fails CI
- **WHEN** a pull request introduces a disallowed cross-scope import (e.g. `scope:mcp`
  importing `scope:ingestion` internals)
- **THEN** the workflow's lint step fails and the overall run is reported as failed
