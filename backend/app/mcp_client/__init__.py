"""Outbound MCP client support. Inbound `/mcp` server code lives separately in `app.mcp`."""

from app.mcp_client.manager import manager

__all__ = ["manager"]
