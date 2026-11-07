# mcp-data-tools Specification

## Purpose

Exposes Draupnir's shared, read-only data tools to MCP clients through the
`mcp` server, so Claude Desktop and similar clients see exactly the same
caller-scoped data as the Telegram AI chat.

## Requirements

### Requirement: The MCP server offers the shared data tools
The MCP server SHALL list and serve exactly the tools defined by `data-tools`
(`list_accounts`, `list_transactions`, `summarize_transactions`,
`get_account_coverage`), plus the existing `whoami`. Each tool's name, input
schema, output, and errors SHALL be those defined by `data-tools`, without
MCP-specific changes to their behavior.

#### Scenario: Tools are listed
- **WHEN** an authenticated MCP client calls `tools/list`
- **THEN** the result contains `whoami` and the four data tools with the input
  schemas defined by `data-tools`

#### Scenario: Tool result matches the shared definition
- **WHEN** an authenticated caller invokes `list_transactions` over MCP with the
  same input as the shared tool is given directly for the same user
- **THEN** both return the same transactions and the same `nextCursor`

#### Scenario: Shared tool error is returned as a tool error
- **WHEN** a caller invokes `list_transactions` over MCP with `limit` above the
  maximum
- **THEN** the MCP response is a tool error carrying the shared tool's message,
  not a transport-level failure

### Requirement: Tools run as the authorizer-identified caller only
Each data tool invoked over MCP SHALL run with the identity of the
authorizer-injected `sub` claim, and SHALL ignore any user or account identity
claimed in the request body for authorization purposes.

#### Scenario: Member sees a shared account
- **WHEN** a caller who is a `viewer` of account A1 invokes `list_accounts` over
  MCP
- **THEN** account A1 is returned with role `viewer`, and no account the caller
  is not a member of is returned

#### Scenario: Body-supplied identity is ignored
- **WHEN** a tool call's arguments include a field naming another user's `sub`
- **THEN** the result is computed for the authorizer-identified caller only

### Requirement: An unresolved caller identity is refused without querying
If a data-tool call reaches the MCP handler without a resolvable `sub` claim,
the tool SHALL return a tool error and SHALL NOT issue any database query. The
`whoami` tool's existing display fallback is unaffected.

#### Scenario: No sub, no query
- **WHEN** a data tool is invoked over MCP and no `sub` claim can be resolved
- **THEN** the response is a tool error and the database is never called

### Requirement: MCP data tools are read-only
No tool exposed over MCP SHALL create, modify, or delete any data.

#### Scenario: Calling any tool leaves data unchanged
- **WHEN** any MCP tool is called with any input
- **THEN** no row in any table is created, modified, or deleted as a result
