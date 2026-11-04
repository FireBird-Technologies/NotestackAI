"""Small synchronous facade over the official async MCP Streamable HTTP client.

Every public method owns the transport and ClientSession inside one asyncio task. This matters because AnyIO cancel
scopes must be entered and exited by the same task. Connections are deliberately short lived for the first release:
it is a little slower, but avoids stale credentials and cross-request session ownership bugs.
"""

import asyncio
import json
import re
from datetime import timedelta
from typing import Any
from urllib.parse import urlsplit

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

from app.config import settings
from app.services.safe_http import UnsafeURL, check_url

_SAFE_TOOL_NAME = re.compile(r"[^a-zA-Z0-9_-]+")
class OutboundToolResult(str):
    """Model-visible text plus the complete MCP result needed by an MCP Apps host.

    It remains a ``str`` so existing callers, audits and URL extraction keep their old behaviour. The extra fields
    are consumed only by the chat adapter and never included in the model-visible tool observation.
    """

    raw_result: dict[str, Any]
    ui_resource_uri: str | None

    def __new__(cls, text: str, raw_result: dict[str, Any], ui_resource_uri: str | None = None):
        value = super().__new__(cls, text)
        value.raw_result = raw_result
        value.ui_resource_uri = ui_resource_uri
        return value


class OutboundMcpError(RuntimeError):
    def __init__(self, message: str, *, status_code: int | None = None, headers: dict[str, str] | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.headers = headers or {}


def _http_failure(exc: BaseException) -> tuple[int | None, dict[str, str]]:
    """Find the HTTP failure hidden inside AnyIO/TaskGroup ExceptionGroups."""
    response = getattr(exc, "response", None)
    if isinstance(response, httpx.Response):
        return response.status_code, dict(response.headers)
    for nested in getattr(exc, "exceptions", ()):
        status, headers = _http_failure(nested)
        if status is not None:
            return status, headers
    cause = getattr(exc, "__cause__", None)
    if cause is not None and cause is not exc:
        return _http_failure(cause)
    return None, {}


def _as_outbound_error(exc: BaseException) -> OutboundMcpError:
    if isinstance(exc, OutboundMcpError):
        return exc
    status, headers = _http_failure(exc)
    if status == 401:
        return OutboundMcpError("This MCP server requires authorization.", status_code=401, headers=headers)
    if status:
        return OutboundMcpError(f"The MCP server returned HTTP {status}.", status_code=status, headers=headers)
    return OutboundMcpError(f"Could not connect to that MCP server: {type(exc).__name__}")


def validate_server_url(url: str) -> str:
    url = (url or "").strip()
    try:
        parts = urlsplit(url)
    except ValueError as exc:
        raise OutboundMcpError("That is not a valid MCP server URL.") from exc
    if parts.query or parts.fragment:
        raise OutboundMcpError("MCP server URLs cannot contain a query string or fragment.")
    if parts.scheme != "https" and not (settings.outbound_mcp_allow_http and parts.scheme == "http"):
        raise OutboundMcpError("Outbound MCP servers must use HTTPS.")
    try:
        check_url(url)
    except UnsafeURL as exc:
        raise OutboundMcpError(str(exc)) from exc
    allowed = settings.outbound_mcp_allowed_host_list
    if allowed and (parts.hostname or "").lower() not in allowed:
        raise OutboundMcpError("That MCP server host is not on the configured allowlist.")
    return url


def _has_ref(value: Any) -> bool:
    if isinstance(value, dict):
        return "$ref" in value or any(_has_ref(v) for v in value.values())
    if isinstance(value, list):
        return any(_has_ref(v) for v in value)
    return False


def tool_is_usable(tool: dict) -> bool:
    """All read and write tools are allowed when their input schema can be represented safely."""
    schema = tool.get("input_schema") or {"type": "object", "properties": {}}
    return isinstance(schema, dict) and not _has_ref(schema)


def enable_read_only_tools(discovered: list[dict], existing: list[str] | None = None) -> list[str]:
    """Keep valid explicit selections and automatically add every usable read-only tool.

    MCP servers identify non-mutating tools with ``readOnlyHint``; discovery stores that as ``read_only``. Write and
    destructive tools are never selected here and remain an explicit user choice.
    """
    usable = {
        tool.get("name")
        for tool in discovered
        if tool.get("name") and tool_is_usable(tool)
    }
    selected = [name for name in dict.fromkeys(existing or []) if name in usable]
    selected_set = set(selected)
    for tool in discovered:
        name = tool.get("name")
        if name in usable and tool.get("read_only") is True and name not in selected_set:
            selected.append(name)
            selected_set.add(name)
    return selected


def _jsonable(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json", by_alias=True, exclude_none=True)
    if isinstance(value, dict):
        return {str(key): _jsonable(child) for key, child in value.items()}
    if isinstance(value, list | tuple):
        return [_jsonable(child) for child in value]
    return value


def _ui_resource_uri(meta: dict | None) -> str | None:
    meta = meta if isinstance(meta, dict) else {}
    ui = meta.get("ui")
    uri = ui.get("resourceUri") if isinstance(ui, dict) else None
    uri = uri or meta.get("ui/resourceUri") or meta.get("openai/outputTemplate")
    return uri if isinstance(uri, str) and uri.startswith("ui://") else None


def _tool_dict(tool: Any) -> dict:
    annotations = getattr(tool, "annotations", None)
    read_only = bool(getattr(annotations, "readOnlyHint", False))
    destructive = bool(getattr(annotations, "destructiveHint", False))
    schema = getattr(tool, "inputSchema", None) or {"type": "object", "properties": {}}
    output_schema = getattr(tool, "outputSchema", None)
    meta = _jsonable(getattr(tool, "meta", None) or getattr(tool, "_meta", None) or {})
    description = " ".join((getattr(tool, "description", None) or "").split())[:600]
    result = {
        "name": str(getattr(tool, "name", ""))[:200],
        "description": description,
        "input_schema": schema,
        "output_schema": output_schema,
        "meta": meta,
        "ui_resource_uri": _ui_resource_uri(meta),
        "read_only": read_only,
        "destructive": destructive,
    }
    result["usable"] = tool_is_usable(result)
    return result


def _headers(token: str | None) -> dict[str, str] | None:
    return {"Authorization": f"Bearer {token}"} if token else None


def _run(coro):
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    raise OutboundMcpError("Outbound MCP synchronous calls cannot run on an event-loop thread.")


async def _discover_async(url: str, token: str | None) -> list[dict]:
    async with streamablehttp_client(
        url,
        headers=_headers(token),
        timeout=settings.outbound_mcp_connect_timeout_seconds,
        sse_read_timeout=settings.outbound_mcp_call_timeout_seconds,
    ) as (read, write, _session_id):
        async with ClientSession(read, write, read_timeout_seconds=timedelta(
            seconds=settings.outbound_mcp_call_timeout_seconds
        )) as session:
            await session.initialize()
            result = await session.list_tools()
            return [_tool_dict(tool) for tool in result.tools]


def _result_text(result: Any) -> str:
    pieces: list[str] = []
    structured = getattr(result, "structuredContent", None)
    if structured is not None:
        pieces.append(json.dumps(structured, ensure_ascii=False, default=str))
    for item in getattr(result, "content", []) or []:
        text = getattr(item, "text", None)
        if isinstance(text, str):
            pieces.append(text)
            continue
        resource = getattr(item, "resource", None)
        resource_text = getattr(resource, "text", None)
        if isinstance(resource_text, str):
            pieces.append(resource_text)
    text = "\n\n".join(pieces).strip() or "(The external tool returned no text.)"
    text = text[:settings.outbound_mcp_max_result_chars]
    if getattr(result, "isError", False):
        raise OutboundMcpError(text)
    return text


async def _call_async(url: str, token: str | None, tool_name: str, arguments: dict) -> OutboundToolResult:
    async with streamablehttp_client(
        url,
        headers=_headers(token),
        timeout=settings.outbound_mcp_connect_timeout_seconds,
        sse_read_timeout=settings.outbound_mcp_call_timeout_seconds,
    ) as (read, write, _session_id):
        async with ClientSession(read, write, read_timeout_seconds=timedelta(
            seconds=settings.outbound_mcp_call_timeout_seconds
        )) as session:
            await session.initialize()
            available = {_tool_dict(tool)["name"]: _tool_dict(tool) for tool in (await session.list_tools()).tools}
            tool = available.get(tool_name, {})
            if not tool.get("usable"):
                raise OutboundMcpError("The MCP tool is unavailable or has an unsupported input schema.")
            result = await session.call_tool(tool_name, arguments)
            text = _result_text(result)
            return OutboundToolResult(text, _jsonable(result), tool.get("ui_resource_uri"))


async def _read_resource_async(url: str, token: str | None, uri: str) -> dict:
    async with streamablehttp_client(
        url,
        headers=_headers(token),
        timeout=settings.outbound_mcp_connect_timeout_seconds,
        sse_read_timeout=settings.outbound_mcp_call_timeout_seconds,
    ) as (read, write, _session_id):
        async with ClientSession(read, write, read_timeout_seconds=timedelta(
            seconds=settings.outbound_mcp_call_timeout_seconds
        )) as session:
            await session.initialize()
            return _jsonable(await session.read_resource(uri))


class OutboundMcpManager:
    def discover(self, url: str, token: str | None = None) -> list[dict]:
        if not settings.outbound_mcp_enabled:
            raise OutboundMcpError("Outbound MCP is disabled.")
        try:
            return _run(_discover_async(validate_server_url(url), token))
        except BaseException as exc:
            raise _as_outbound_error(exc) from exc

    def call(self, url: str, token: str | None, tool_name: str, arguments: dict) -> str:
        if not settings.outbound_mcp_enabled:
            raise OutboundMcpError("Outbound MCP is disabled.")
        if not tool_name or _SAFE_TOOL_NAME.search(tool_name):
            raise OutboundMcpError("Invalid MCP tool name.")
        try:
            return _run(_call_async(validate_server_url(url), token, tool_name, arguments))
        except BaseException as exc:
            raise _as_outbound_error(exc) from exc

    def read_resource(self, url: str, token: str | None, uri: str) -> dict:
        if not settings.outbound_mcp_enabled:
            raise OutboundMcpError("Outbound MCP is disabled.")
        if not isinstance(uri, str) or not uri.startswith("ui://") or len(uri) > 2000:
            raise OutboundMcpError("Invalid MCP App resource URI.")
        try:
            return _run(_read_resource_async(validate_server_url(url), token, uri))
        except BaseException as exc:
            raise _as_outbound_error(exc) from exc


manager = OutboundMcpManager()
