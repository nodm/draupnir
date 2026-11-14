# mcp

This is the MCP Lambda application (API Gateway-triggered), scaffolded with [Nx](https://nx.dev).

## Building

Run `nx build mcp` to bundle the Lambda handler.

## Running unit tests

Run `nx test mcp` to execute the unit tests via [Vitest](https://vitest.dev).

## Connecting an MCP client

The server is at `https://mcp.draupnir.nodm.name/mcp` (also `mcpUrl` in the Pulumi outputs).
Clients discover sign-in from that URL alone and register themselves; sign in with the Google
account on the allowlist. See [ADR-0012](../docs/adr/0012-mcp-client-authorization.md).

- claude.ai: Settings → Connectors → add a custom connector with the URL. Claude Desktop, mobile and
  Claude Code use the same connector when signed in to the claude.ai account.

Only access tokens are accepted (ID tokens get `401`). `/register` only accepts the claude.ai and
claude.com callbacks, so it can create at most three clients.

Clients created by `/register` are named `mcp-dcr-<hash>` and live outside Pulumi. List and remove
them (cap: 25) with `aws cognito-idp list-user-pool-clients` and `delete-user-pool-client`; the
exact command is in the ADR.
