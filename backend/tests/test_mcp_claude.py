# ruff: noqa: F811, E501
"""Claude's view of the server: titles on every tool, descriptions without routing orders, neutral instructions, and
everything else (ChatGPT, Cursor ...) left exactly as it was."""

import re

import pytest
from mcp.server.auth.provider import AccessToken
from mcp.server.fastmcp.exceptions import ToolError

from app.mcp import claude_profile, common, policy
from tests.test_buildout import auth, connect, docs, feed  # noqa: F401  (fixtures and helpers)
from tests.test_mcp import CHATGPT, CLAUDE, anyio_backend, bearer, http, live, mcp, mcp_db, sign_in  # noqa: F401

ROUTING = re.compile(r"call [a-z_]+ (before|immediately|instead|first)|USE THIS|MANDATORY|(?-i:\bMUST\b|\bNEVER\b)|"
                     r"Required readiness|never call it yourself", re.I)  # shouted MUST/NEVER only


def as_app(monkeypatch, app):
    access = AccessToken(token="x", client_id="c", scopes=["mcp:read"], claims={"app": app})
    monkeypatch.setattr(common, "get_access_token", lambda: access)


def test_claude_is_recognised_by_where_it_returns_to():
    assert policy.connected_app({"client_name": "Claude", "redirect_uris": [CLAUDE]}) == "claude"
    assert policy.connected_app({"client_name": "anything", "redirect_uris": ["https://claude.com/api/mcp/auth_callback"]}) == "claude"
    assert policy.connected_app({"client_name": "Claude Code (notestack)", "redirect_uris": ["http://localhost:3118/callback"]}) == "claude"
    assert policy.connected_app({"client_name": "ChatGPT", "redirect_uris": [CHATGPT]}) == "other"
    assert policy.connected_app({"client_name": "Claude", "redirect_uris": ["https://evil.example/cb"]}) == "other"
    assert policy.connected_app({"client_name": "Cursor", "redirect_uris": ["http://localhost:1/cb"]}) == "other"
    assert policy.connected_app(None) == "other"


@pytest.mark.anyio
async def test_other_apps_see_exactly_the_original_tools(mcp, monkeypatch):
    from mcp.server.fastmcp import FastMCP

    as_app(monkeypatch, "other")
    assert await mcp.list_tools() == await FastMCP.list_tools(mcp)
    options = mcp._mcp_server.create_initialization_options()
    assert options.instructions == mcp.instructions and "MANDATORY ROUTING" in options.instructions


@pytest.mark.anyio
async def test_claude_sees_every_tool_titled_and_described_plainly(mcp, monkeypatch):
    as_app(monkeypatch, "other")
    original = {t.name: t for t in await mcp.list_tools()}
    as_app(monkeypatch, "claude")
    listed = {t.name: t for t in await mcp.list_tools()}
    assert set(listed) == set(original)  # nothing hidden
    assert set(claude_profile.TITLES) == set(original)  # every tool has a chosen title, not the fallback
    for name, t in listed.items():
        assert t.title and t.annotations.title == t.title, name
        assert not ROUTING.search(t.description), (name, ROUTING.search(t.description).group(0))
        same = original[name]
        assert (t.inputSchema, t.annotations.readOnlyHint, t.annotations.destructiveHint, t.meta) == \
               (same.inputSchema, same.annotations.readOnlyHint, same.annotations.destructiveHint, same.meta), name
    assert set(claude_profile.DESCRIPTIONS) <= set(original)
    instructions = mcp._mcp_server.create_initialization_options().instructions
    assert instructions == claude_profile.INSTRUCTIONS and not ROUTING.search(instructions)


@pytest.mark.anyio
async def test_a_hidden_tool_is_gone_for_claude_only(mcp, monkeypatch):
    monkeypatch.setattr(claude_profile, "HIDDEN", {"generate_video"})
    as_app(monkeypatch, "claude")
    assert "generate_video" not in {t.name for t in await mcp.list_tools()}
    with pytest.raises(ToolError, match="not available in Claude"):
        await mcp.call_tool("generate_video", {})
    as_app(monkeypatch, "other")
    assert "generate_video" in {t.name for t in await mcp.list_tools()}


def test_an_empty_library_is_explained_without_orders_to_claude(monkeypatch):
    as_app(monkeypatch, "claude")
    claude = common.empty_archive("quiz")
    assert claude["error"] == "empty_archive" and claude["next_tool"] == "connect_sources"
    assert not ROUTING.search(claude["tell_the_writer"] + claude["next_step"])
    as_app(monkeypatch, "other")
    assert common.empty_archive("quiz")["tell_the_writer"] == common.EMPTY_ARCHIVE["tell_the_writer"]


@pytest.mark.anyio
@pytest.mark.parametrize("redirect, claude", [(CLAUDE, True), (CHATGPT, False)])
async def test_the_connected_app_decides_the_wording_over_http(http, auth, live, redirect, claude):  # noqa: F811
    t = await sign_in(http, auth, redirect=redirect)
    h = {**bearer(t["access_token"]), "Accept": "application/json, text/event-stream", "Content-Type": "application/json"}

    async def rpc(method, params=None, id_=1):
        r = await http.post("/mcp", headers=h, json={"jsonrpc": "2.0", "id": id_, "method": method, "params": params or {}})
        assert r.status_code == 200, r.text
        return r.json()["result"]

    init = await rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}})
    assert ("MANDATORY ROUTING" not in init["instructions"]) is claude
    tools = {x["name"]: x for x in (await rpc("tools/list", id_=2))["tools"]}
    assert (tools["find_content"].get("title") == "Find content") is claude
    assert tools["start_notestack"]["description"].startswith("Required readiness") is not claude
