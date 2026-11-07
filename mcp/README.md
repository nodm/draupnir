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

- Claude Code: `claude mcp add --transport http draupnir https://mcp.draupnir.nodm.name/mcp`,
  then `/mcp` and authenticate.
- claude.ai / Claude Desktop: Settings → Connectors → add a custom connector with the URL.

Only access tokens are accepted (ID tokens get `401`). `/register` only accepts the claude.ai and
claude.com callbacks and `http://localhost` / `http://127.0.0.1` loopback callbacks.

Clients created by `/register` are named `mcp-dcr-<hash>` and live outside Pulumi. List and remove
them (cap: 25) with `aws cognito-idp list-user-pool-clients` and `delete-user-pool-client`; the
exact command is in the ADR.
