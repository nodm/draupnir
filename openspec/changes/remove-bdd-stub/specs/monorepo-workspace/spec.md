## REMOVED Requirements

### Requirement: Cucumber/Gherkin BDD is scoped to ingestion
**Reason**: The BDD target only ever ran a scaffold stub, was never part of CI, and ingestion behaviour is specified and tested with Vitest against real migrations in pglite.
**Migration**: None. Describe ingestion behaviour as Vitest specs next to the code (e.g. `ingestion/src/lib/processStatementFile.spec.ts`).
