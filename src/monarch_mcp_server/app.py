"""FastMCP application instance and entry point."""

import logging
import os

try:  # mcp >= 2.0 renamed FastMCP to MCPServer
    from mcp.server.mcpserver import MCPServer as FastMCP
except ImportError:  # mcp < 2.0
    from mcp.server.fastmcp import FastMCP

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# The gql aiohttp transport logs full GraphQL requests/responses at INFO, which
# can include Monarch account payloads. Raise its floor to WARNING so those
# payloads are not written to logs. Transport-level errors still surface; drop
# this to INFO/DEBUG temporarily if you need to trace GraphQL traffic.
logging.getLogger("gql.transport.aiohttp").setLevel(logging.WARNING)

# Initialize FastMCP server
mcp = FastMCP("Monarch Money MCP Server")

# Must run before the tool modules are imported, since it works by wrapping
# mcp.tool() and registration happens at import time.
from monarch_mcp_server import read_only  # noqa: E402

read_only.install(mcp)

# Import tools package to trigger @mcp.tool() registration
import monarch_mcp_server.tools  # noqa: E402, F401

# Export for `mcp run`
app = mcp


def main() -> None:
    """Start a local stdio server or the private Streamable HTTP origin.

    ``stdio`` remains the default so existing Claude Desktop and Claude Code
    configurations keep working.  Production sets ``MONARCH_MCP_TRANSPORT`` to
    ``streamable-http`` and binds only to the VPS loopback interface; the
    Cloudflare OAuth edge is the public endpoint.
    """
    logger.info("Starting Monarch Money MCP Server...")
    transport = os.getenv("MONARCH_MCP_TRANSPORT", "stdio")
    if transport not in {"stdio", "streamable-http"}:
        raise ValueError(
            "MONARCH_MCP_TRANSPORT must be 'stdio' or 'streamable-http'"
        )

    if transport == "streamable-http":
        try:
            port = int(os.getenv("MONARCH_MCP_PORT", "8788"))
        except ValueError as error:
            raise ValueError("MONARCH_MCP_PORT must be an integer") from error
        # MCP SDK 1.x reads HTTP listener configuration from ``settings``;
        # passing these to ``run`` only works in newer SDK versions.
        mcp.settings.host = os.getenv("MONARCH_MCP_HOST", "127.0.0.1")
        mcp.settings.port = port
        mcp.settings.streamable_http_path = "/mcp"

    try:
        mcp.run(transport=transport)
    except Exception as e:
        logger.error(f"Failed to run server: {str(e)}")
        raise


if __name__ == "__main__":
    main()
