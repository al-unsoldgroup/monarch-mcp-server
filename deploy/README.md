# Production deployment

`monarch-mcp.service` starts the MCP server only on `127.0.0.1:8788` and
keeps all mutating Monarch tools unregistered. `finance-origin.caddy` only
forwards requests that carry the Worker-managed origin credential.

The public OAuth resource is `https://finance.unsold.cloud/mcp`. The private
origin hostname is for the Cloudflare Worker only and must remain protected by
the Cloudflare Tunnel and Caddy credential check.
