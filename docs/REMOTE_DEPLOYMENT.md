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
