## Purpose

Defines how schema changes are described, recorded, and applied to the Aurora
cluster, so the live database always matches the schema the code was written
and tested against, without manual DDL steps.

## ADDED Requirements

### Requirement: Migrations are an ordered, append-only list
The system SHALL define every schema change as a migration with a unique,
ordered identifier (e.g. `0001-…`, `0002-…`) and SHALL apply pending migrations
in ascending identifier order. A migration, once applied to any database, SHALL
NOT be edited or removed; schema changes after that point SHALL be new
migrations.

#### Scenario: Pending migrations apply in order
- **WHEN** a database has migration `0001` applied and migrations `0002` and
  `0003` are pending
- **THEN** the runner applies `0002` before `0003`, and both are recorded as
  applied afterwards

#### Scenario: Fresh database receives every migration
- **WHEN** the runner runs against a database with no migrations applied
- **THEN** every defined migration is applied in identifier order

### Requirement: Applied migrations are recorded in the database
The database SHALL contain a `schema_migrations` table recording, for each
applied migration, its identifier, a checksum of its content, and the time it
was applied. The runner SHALL create this table if it does not exist.

#### Scenario: Applied migration is recorded
- **WHEN** the runner applies a migration
- **THEN** `schema_migrations` contains a row with that migration's identifier,
  its checksum, and an applied-at timestamp

#### Scenario: Re-running with nothing pending changes nothing
- **WHEN** the runner runs and every defined migration is already recorded
- **THEN** no schema change is made and no new `schema_migrations` row is
  written

### Requirement: Each migration applies atomically
Each migration's statements and its `schema_migrations` row SHALL be committed
together or not at all. A failing statement SHALL leave the database exactly as
it was before that migration started, and the runner SHALL stop without
applying any later migration.

#### Scenario: Failing statement rolls back the whole migration
- **WHEN** a migration's second statement fails
- **THEN** the effects of its first statement are not present, no
  `schema_migrations` row exists for it, and later migrations are not applied

#### Scenario: Earlier successful migrations stay applied
- **WHEN** migration `0002` applies successfully and migration `0003` then fails
- **THEN** `0002` remains applied and recorded, and `0003` is neither applied
  nor recorded

### Requirement: A modified applied migration is refused
If a migration recorded in `schema_migrations` no longer matches the recorded
checksum, the runner SHALL fail before applying anything and SHALL report which
migration changed.

#### Scenario: Edited migration blocks the run
- **WHEN** migration `0001` is recorded as applied and its content is later
  changed
- **THEN** the runner fails, names `0001` in its error, and applies no pending
  migration

### Requirement: Concurrent runs cannot apply the same migration twice
The runner SHALL serialize itself so that two runs started at the same time
against the same database never apply the same migration twice or interleave
their statements.

#### Scenario: Two simultaneous runs
- **WHEN** two runner invocations start at the same time with the same pending
  migration
- **THEN** that migration is applied and recorded exactly once, and both
  invocations finish without error

### Requirement: Migrations run as part of deployment, before application code
Deploying the stack SHALL run the migration runner whenever the set of defined
migrations has changed, through the same RDS Data API access path as the
application (no VPC attachment, no direct Postgres connection). Application
functions that depend on the schema SHALL be updated only after the runner has
succeeded, and a runner failure SHALL fail the deployment.

#### Scenario: New migration is applied on deploy
- **WHEN** a new migration is added and the stack is deployed
- **THEN** the migration is applied to the live cluster during that deployment
  and recorded in `schema_migrations`

#### Scenario: Failed migration fails the deploy
- **WHEN** a migration fails during deployment
- **THEN** the deployment reports failure and application functions are not
  updated to code that expects the new schema

#### Scenario: Unchanged migration set does not re-run
- **WHEN** the stack is deployed with no change to the defined migrations
- **THEN** the runner is not invoked

#### Scenario: Paused cluster is resumed, not treated as a failure
- **WHEN** the runner starts while the cluster is auto-paused
- **THEN** it waits for the cluster to resume and applies pending migrations,
  rather than failing on the first resume-in-progress response

### Requirement: Migration 0001 adopts the existing live schema
The first migration SHALL bring both a fresh database and the existing live
cluster (which already has `accounts` and `transactions`, created manually, but
no `share_grants`) to the same schema, without modifying or deleting existing
rows.

#### Scenario: Live cluster with manually created tables
- **WHEN** migration `0001` runs against a database where `accounts` and
  `transactions` already exist with rows, and `share_grants` does not
- **THEN** `share_grants` is created, the existing tables and their rows are
  unchanged, and `0001` is recorded as applied

#### Scenario: Fresh database
- **WHEN** migration `0001` runs against an empty database
- **THEN** `accounts`, `transactions`, and `share_grants` all exist with the
  schema defined by `transactions-schema` and `row-level-authorization`
