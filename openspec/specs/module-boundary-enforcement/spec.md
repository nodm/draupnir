# module-boundary-enforcement Specification

## Purpose

Enforces the scope tag matrix at lint time so a cross-boundary import — including from a
future `scope:web` package into `scope:ingestion` — is caught before review instead of at
runtime or by convention.

## Requirements

### Requirement: Cross-scope imports are restricted by tag
The workspace SHALL configure `@nx/enforce-module-boundaries` so that: `scope:infra` may
depend on `scope:shared`; `scope:ingestion` and `scope:mcp` may each depend on
`scope:shared`; `scope:ingestion` and `scope:mcp` SHALL NOT depend on each other; and any
project tagged `scope:web` SHALL NOT depend on `scope:ingestion` at all (only on
`scope:shared`). `depConstraints` gates dependencies at the whole-project level, not per
export, so there is no "public export exempt" carve-out for any of these pairs — anything
a `type:app` Lambda project needs to share with another app belongs in `scope:shared`,
not in an exported surface of the app itself.

#### Scenario: Disallowed import fails lint
- **WHEN** a file in a project tagged `scope:mcp` imports directly from a file inside the
  `ingestion` project
- **THEN** `nx lint mcp` (or the equivalent affected lint run) fails with an
  `enforce-module-boundaries` violation

#### Scenario: Web-to-ingestion import fails lint
- **WHEN** a project tagged `scope:web` imports from the `ingestion` project, including its
  public entry point
- **THEN** lint fails with an `enforce-module-boundaries` violation, even though no
  `scope:web` project exists yet in this change

#### Scenario: Allowed import passes lint
- **WHEN** a file in the `ingestion` project imports from the `shared` project's public
  entry point
- **THEN** `nx lint ingestion` passes with no boundary violation
