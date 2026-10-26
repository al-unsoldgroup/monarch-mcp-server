# Finance MCP remote deployment

The connector URL is `https://finance.unsold.cloud/mcp`.

```text
Claude.ai -> Cloudflare OAuth Worker -> Cloudflare Tunnel -> Caddy -> Monarch MCP
```

The Worker authenticates the connector through a dedicated Cloudflare Access
OIDC app. It only accepts `alexandre.stemarie@gmail.com` and issues OAuth
tokens with the `monarch:read` scope. The Worker adds an origin credential
that Caddy verifies before it proxies to the MCP server on `127.0.0.1:8788`.
No public VPS port is opened.

The service sets `MONARCH_MCP_READ_ONLY=1`, so all mutating Monarch tools are
absent from the catalog. This deployment is for extraction and analysis. A
future importer should be a separate, narrowly scoped service with explicit
write approval.

The deployment also enables the two secure MCP elicitation forms,
`monarch_login` and `monarch_login_with_token`, for one-time session setup.
They collect credentials directly in the MCP client UI and do not expose them
to the model. All financial mutation tools remain absent.

## Import unsupported-bank transactions

Use the local VPS command after reviewing a CSV. The required columns are
`date`, `amount`, `merchant_name`, and `category_id`; `notes` is optional.
The first run is a preview and returns a confirmation token. No transaction is
created until the same file is run again with `--apply --confirm <token>`:

```bash
cd /opt/monarch-mcp-server
.venv/bin/monarch-mcp-import-transactions bank.csv --account-id <monarch-account-id>
.venv/bin/monarch-mcp-import-transactions bank.csv --account-id <monarch-account-id> \
  --apply --confirm <preview-token>
```

The importer is intentionally not an MCP tool. It retains an explicit
operator review step and does not enlarge Claude.ai's access.

## One-time Monarch session setup

On the VPS, create a 0600 cookie file at
`/root/.config/monarch-mcp/cookie.txt`, paste the full `cookie:` request
header from an authenticated `api.monarch.com/graphql` browser request, and
run:

```bash
cd /opt/monarch-mcp-server
.venv/bin/python login_setup.py
```

The setup script verifies the session and stores it in the service account's
secure session store. Restart `monarch-mcp` afterward. Do not place the cookie
in this repository, a Worker secret, or a chat message.

## Connect Claude.ai

In Claude.ai, add a custom connector using
`https://finance.unsold.cloud/mcp`. Complete the Cloudflare Access sign-in and
approve the connector. OAuth discovery and dynamic client registration are
served by the Worker.

## Register on the Cloudflare MCP server portals

Both portals reach this server as an ordinary OAuth-protected upstream. In
Cloudflare One, open Access controls, AI controls, MCP servers:

1. Add an MCP server named `monarch` with URL
   `https://finance.unsold.cloud/mcp`. Choose OAuth as the authentication
   method and complete the Cloudflare Access sign-in as
   `alexandre.stemarie@gmail.com`.
2. Add a second MCP server named `monarch-chatgpt` with URL
   `https://finance.unsold.cloud/mcp?surface=chatgpt`, authenticated the same
   way.
3. Attach `monarch` to the Claude portal and `monarch-chatgpt` to the ChatGPT
   portal. Leave the tool allowlist at its default unless a policy says
   otherwise.
4. Sync the server's tools in the portal and confirm the catalog loads.

The upstream sees the portal as its client, so `clientInfo` cannot tell
ChatGPT from Claude. The `?surface=` query parameter does: it becomes
`mcp_surface` on every analytics event. The Worker forwards it to the origin,
which ignores it.

## Tool-call analytics

The Worker emits one PostHog `$mcp_tool_call` event per `tools/call` it
proxies (`edge/src/telemetry.ts`). The event uses the same name and property
names as the shared `@unsoldgroup/mcp-telemetry` package, so Monarch appears
next to the TypeScript MCP servers in PostHog's MCP views:
`$mcp_tool_name`, `$mcp_duration_ms`, `$mcp_is_error`, `mcp_surface`
(`claude` unless the connector URL has a valid `?surface=`), `tool_tier`
(`read`, `write` or `destructive`), `sensitive` and `mcp_server_name`
(`monarch-mcp`). Tool arguments and results are never sent.

The Worker does not use the shared package because it does not host an
`McpServer`: it is a transparent proxy, and the MCP server is the Python
FastMCP origin. The tap reads a copy of the request and response body, so
the client stream is not delayed. `$mcp_duration_ms` is measured at the edge,
so it includes the tunnel round trip.

Analytics are off until the optional secret is set:

```bash
cd edge && npx wrangler secret put POSTHOG_PROJECT_TOKEN
```

`POSTHOG_HOST`, `ENVIRONMENT` and the optional `DEPLOY_GIT_SHA` are plain
vars. `edge/src/telemetry.ts` holds the tier map for every tool in the README
table, and `pnpm test` in `edge/` fails if a tool is added without a tier.
