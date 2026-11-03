## ADDED Requirements

### Requirement: Application code uses a database role that cannot bypass row-level security
Every application function (ingestion API, ingestion worker, mcp, and later the
bot) SHALL authenticate Data API requests with a dedicated application
credential. That credential's database role SHALL NOT own any table, SHALL NOT
have `BYPASSRLS`, and SHALL NOT be a superuser. The master credential SHALL be
granted only to the migration runner. Both credentials SHALL be stored in
Secrets Manager, never in Pulumi config, environment variables, or source in
plaintext.

#### Scenario: Application functions reference the application secret
- **WHEN** the environment and IAM permissions of every application Lambda are
  inspected
- **THEN** each references the application credential's secret, and none can
  read the master credential's secret

#### Scenario: Application role is subject to RLS
- **WHEN** the application role's attributes and table ownership are inspected
- **THEN** it owns no table and has neither `BYPASSRLS` nor superuser

#### Scenario: Migration runner keeps the master credential
- **WHEN** the migration runner Lambda's configuration is inspected
- **THEN** it references the master credential's secret
