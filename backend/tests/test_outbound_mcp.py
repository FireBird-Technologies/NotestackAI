"""Outbound MCP is user-scoped, encrypted, bounded, and usable by the research agent."""

import json
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

import pytest
from sqlalchemy import select

from app.config import settings
from app.mcp_client import manager as outbound_manager
from app.mcp_client import oauth as oauth_service
from app.mcp_client.manager import (
    OutboundMcpError,
    OutboundToolResult,
    _result_text,
    _tool_dict,
    validate_server_url,
)
from app.mcp_client.oauth import OAuthFlowError, access_token_for, finish_authorization, start_authorization
from app.mcp_client.tools import MODEL_TOOL_DESCRIPTION_CHARS, _resource_urls, load_external_tools, widget_is_displayable
from app.models import (
    Notebook,
    NotebookMcpConnection,
    OutboundMcpAuthAttempt,
    OutboundMcpConnection,
    OutboundMcpGrant,
    OutboundMcpOAuthClient,
)
from app.pipeline import research as research_module
from app.services.crypto import decrypt, encrypt
from tests.conftest import last_code


@pytest.fixture(autouse=True)
def no_icon_network(monkeypatch):
    monkeypatch.setattr("app.mcp_client.icon.fetch_server_icon", lambda url: None)


@pytest.fixture()
def auth(client):
    client.post("/api/auth/email/register/start", json={
        "email": "mcp@example.com", "password": "stardust-42", "name": "MCP User",
    })
    response = client.post("/api/auth/email/register/verify", json={
        "email": "mcp@example.com", "code": last_code(),
    })
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


TOOLS = [
    {"name": "search_issues", "description": "Search issues", "input_schema": {
        "type": "object", "properties": {"query": {"type": "string"}},
    }, "read_only": True, "destructive": False, "usable": True},
    {"name": "delete_repo", "description": "Delete", "input_schema": {
        "type": "object", "properties": {},
    # Simulates metadata saved before write tools were enabled; runtime capability is recomputed from the schema.
    }, "read_only": False, "destructive": True, "usable": False},
]


def test_connection_crud_encrypts_token_and_allows_read_and_write_tools(client, auth, db_session, monkeypatch):
    monkeypatch.setattr(outbound_manager, "discover", lambda url, token=None: TOOLS)
    response = client.post("/api/outbound-mcp/connections", headers=auth, json={
        "name": "GitHub", "server_url": "https://mcp.example.com/mcp", "bearer_token": "secret-token",
    })
    assert response.status_code == 201, response.text
    row = db_session.scalar(select(OutboundMcpConnection))
    assert row.access_token_encrypted != "secret-token"
    assert decrypt(row.access_token_encrypted) == "secret-token"
    body = response.json()
    assert body["has_token"] is True and "access_token" not in body
    assert body["enabled_tools"] == ["search_issues"]
    assert next(tool for tool in body["discovered_tools"] if tool["name"] == "delete_repo")["usable"] is True

    enabled = client.patch(f"/api/outbound-mcp/connections/{row.id}", headers=auth,
                           json={"enabled_tools": ["search_issues", "delete_repo"]})
    assert enabled.status_code == 200
    assert enabled.json()["enabled_tools"] == ["search_issues", "delete_repo"]

    monkeypatch.setattr(
        "app.routers.outbound_mcp.probe_authorization",
        lambda *_args: pytest.fail("bearer-token connections must not be probed for OAuth"),
    )
    listed = client.get("/api/outbound-mcp/connections", headers=auth)
    assert listed.status_code == 200
    assert listed.json()[0]["auth_status"] == "ready"
    assert listed.json()[0]["status"] == "ready"

    assert client.delete(f"/api/outbound-mcp/connections/{row.id}", headers=auth).json() == {"ok": True}
    db_session.expire_all()
    removed = db_session.get(OutboundMcpConnection, row.id)
    assert removed is not None and removed.deleted_at is not None and removed.status == "removed"
    assert removed.server_url == "https://mcp.example.com/mcp" and removed.discovered_tools == TOOLS
    assert removed.access_token_encrypted is None and not removed.enabled and removed.enabled_tools == []
    assert client.get("/api/outbound-mcp/connections", headers=auth).json() == []
    assert load_external_tools(removed.workspace_id, removed.user_id, db_session).tools == []

    # Reconnecting creates a fresh lifecycle and rediscovers tools; the removed row remains as history.
    reconnected = client.post("/api/outbound-mcp/connections", headers=auth, json={
        "name": "GitHub", "server_url": "https://mcp.example.com/mcp", "bearer_token": "new-secret-token",
    })
    assert reconnected.status_code == 201, reconnected.text
    assert reconnected.json()["id"] != str(removed.id)
    assert len(db_session.scalars(select(OutboundMcpConnection)).all()) == 2
    assert [item["id"] for item in client.get("/api/outbound-mcp/connections", headers=auth).json()] == [
        reconnected.json()["id"]
    ]


def test_any_number_of_tools_can_be_enabled(client, auth, db_session, monkeypatch):
    tools = [{
        "name": f"read_{index}", "description": f"Read {index}",
        "input_schema": {"type": "object", "properties": {}},
        "read_only": True, "destructive": False, "usable": True,
    } for index in range(125)]
    monkeypatch.setattr(outbound_manager, "discover", lambda url, token=None: tools)
    monkeypatch.setattr("app.routers.outbound_mcp.probe_authorization", lambda _db, _row: False)
    created = client.post("/api/outbound-mcp/connections", headers=auth, json={
        "name": "Many tools", "server_url": "https://mcp.example.com/mcp",
    })
    assert created.status_code == 201, created.text

    names = [tool["name"] for tool in tools]
    response = client.patch(
        f"/api/outbound-mcp/connections/{created.json()['id']}", headers=auth, json={"enabled_tools": names},
    )
    assert response.status_code == 200, response.text
    assert response.json()["enabled_tools"] == names

    user = db_session.scalar(select(__import__("app.models", fromlist=["User"]).User))
    bundle = load_external_tools(user.memberships[0].workspace.id, user.id, db_session)
    assert len(bundle.tools) == len(tools)


def test_refresh_always_adds_read_only_tools_without_adding_writes(client, auth, monkeypatch):
    def tool(name: str, *, read_only: bool = False) -> dict:
        return {
            "name": name, "description": name, "input_schema": {"type": "object", "properties": {}},
            "read_only": read_only, "destructive": False, "usable": True,
        }

    initial = [tool("read_old", read_only=True), tool("write_keep")]
    monkeypatch.setattr(outbound_manager, "discover", lambda *_args: initial)
    created = client.post("/api/outbound-mcp/connections", headers=auth, json={
        "name": "Refresh policy", "server_url": "https://mcp.example.com/mcp", "bearer_token": "token",
    })
    assert created.status_code == 201, created.text
    connection_id = created.json()["id"]
    assert created.json()["enabled_tools"] == ["read_old"]

    selected = client.patch(
        f"/api/outbound-mcp/connections/{connection_id}", headers=auth,
        json={"enabled_tools": ["write_keep"]},
    )
    assert selected.status_code == 200, selected.text

    refreshed_tools = [
        tool("read_old", read_only=True), tool("read_new", read_only=True),
        tool("write_keep"), tool("write_new"),
    ]
    monkeypatch.setattr(outbound_manager, "discover", lambda *_args: refreshed_tools)
    refreshed = client.post(f"/api/outbound-mcp/connections/{connection_id}/refresh", headers=auth)
    assert refreshed.status_code == 200, refreshed.text
    assert refreshed.json()["enabled_tools"] == ["write_keep", "read_old", "read_new"]


def test_agent_sees_compact_tool_definitions_but_execution_keeps_full_schema(db_session, auth):
    user = db_session.scalar(select(__import__("app.models", fromlist=["User"]).User))
    workspace = user.memberships[0].workspace
    verbose = {
        "name": "send_message",
        "description": "Send a message to a channel. " + "Long discovery metadata. " * 30,
        "input_schema": {
            "type": "object",
            "required": ["channel", "message"],
            "properties": {
                "channel": {
                    "type": "string", "title": "Channel identifier", "examples": ["C123"],
                    "description": "Slack channel ID.",
                },
                "message": {"type": "string", "description": "Message text."},
                "options": {
                    "type": "object",
                    "properties": {
                        "format": {"enum": ["plain", "markdown"]},
                        "notify": {"type": "boolean"},
                    },
                },
            },
        },
        "read_only": False, "destructive": False, "usable": True,
    }
    row = OutboundMcpConnection(
        workspace_id=workspace.id, user_id=user.id, name="Slack", server_url="https://mcp.example.com/mcp",
        auth_type="none", enabled=True, enabled_tools=["send_message"], discovered_tools=[verbose], status="ready",
    )
    db_session.add(row)
    db_session.commit()

    tool = load_external_tools(workspace.id, user.id, db_session).tools[0]
    rendered = str(tool)

    assert "channel!:string" in rendered and "message!:string" in rendered
    assert 'options?:{format?:enum["plain"|"markdown"],notify?:boolean}' in rendered
    assert "Long discovery metadata" in rendered and len(tool.desc) <= MODEL_TOOL_DESCRIPTION_CHARS
    assert "'title':" not in rendered and "'examples':" not in rendered and "'properties':" not in rendered
    # DSPy executes with the original property schemas; only the text inserted into ReAct was compacted.
    assert tool.args == verbose["input_schema"]["properties"]


def test_notebook_can_disable_one_connected_server(client, auth, db_session):
    user = db_session.scalar(select(__import__("app.models", fromlist=["User"]).User))
    workspace = user.memberships[0].workspace
    notebook = Notebook(workspace_id=workspace.id, title="Private research")
    connection = OutboundMcpConnection(
        workspace_id=workspace.id, user_id=user.id, name="Notion", server_url="https://mcp.example.com/mcp",
        auth_type="none", enabled=True, enabled_tools=["search_issues"], discovered_tools=TOOLS, status="ready",
    )
    db_session.add_all([notebook, connection])
    db_session.commit()

    listed = client.get(f"/api/notebooks/{notebook.id}/connectors", headers=auth)
    assert listed.status_code == 200, listed.text
    assert listed.json()[0]["notebook_enabled"] is True
    assert listed.json()[0]["available"] is True
    assert len(load_external_tools(workspace.id, user.id, db_session, notebook_id=notebook.id).tools) == 1

    disabled = client.patch(
        f"/api/notebooks/{notebook.id}/connectors/{connection.id}", headers=auth, json={"enabled": False},
    )
    assert disabled.status_code == 200, disabled.text
    assert disabled.json()["notebook_enabled"] is False
    assert db_session.get(NotebookMcpConnection, (notebook.id, connection.id)).enabled is False
    assert load_external_tools(workspace.id, user.id, db_session, notebook_id=notebook.id).tools == []
    # The same globally connected service is still available without this notebook's explicit override.
    assert len(load_external_tools(workspace.id, user.id, db_session).tools) == 1


def test_url_policy_requires_public_https():
    assert validate_server_url("https://mcp.example.com/mcp") == "https://mcp.example.com/mcp"
    with pytest.raises(OutboundMcpError, match="HTTPS"):
        validate_server_url("http://mcp.example.com/mcp")
    with pytest.raises(OutboundMcpError, match="query"):
        validate_server_url("https://mcp.example.com/mcp?token=bad")
    with pytest.raises(OutboundMcpError, match="private"):
        validate_server_url("https://127.0.0.1/mcp")


def test_tool_annotations_are_preserved_without_blocking_writes():
    safe = SimpleNamespace(name="read", description="Read", inputSchema={"type": "object"},
                           annotations=SimpleNamespace(readOnlyHint=True, destructiveHint=False))
    write = SimpleNamespace(name="write", description="Write", inputSchema={"type": "object"},
                            annotations=SimpleNamespace(readOnlyHint=False, destructiveHint=False))
    destructive = SimpleNamespace(name="delete", description="Delete", inputSchema={"type": "object"},
                                  annotations=SimpleNamespace(readOnlyHint=False, destructiveHint=True))
    refs = SimpleNamespace(name="refs", description="Refs", inputSchema={"$ref": "hostile"},
                           annotations=SimpleNamespace(readOnlyHint=True, destructiveHint=False))
    assert _tool_dict(safe)["usable"] is True
    assert _tool_dict(write)["usable"] is True
    assert _tool_dict(destructive)["usable"] is True
    assert _tool_dict(refs)["usable"] is False


def test_tool_ui_metadata_and_output_schema_are_preserved():
    tool = SimpleNamespace(
        name="gallery",
        description="Show gallery",
        inputSchema={"type": "object", "properties": {}},
        outputSchema={"type": "object", "properties": {"items": {"type": "array"}}},
        annotations=SimpleNamespace(readOnlyHint=True, destructiveHint=False),
        meta={"ui": {"resourceUri": "ui://example/gallery"}, "openai/widgetAccessible": True},
    )
    saved = _tool_dict(tool)
    assert saved["output_schema"]["properties"]["items"]["type"] == "array"
    assert saved["meta"]["openai/widgetAccessible"] is True
    assert saved["ui_resource_uri"] == "ui://example/gallery"


def test_external_adapter_labels_untrusted_data_and_tracks_source(db_session, auth, monkeypatch, caplog):
    user = db_session.scalar(select(__import__("app.models", fromlist=["User"]).User))
    workspace = user.memberships[0].workspace
    row = OutboundMcpConnection(
        workspace_id=workspace.id, user_id=user.id, name="GitHub", server_url="https://mcp.example.com/mcp",
        auth_type="none", enabled=True, enabled_tools=["search_issues"], discovered_tools=TOOLS, status="ready",
    )
    db_session.add(row)
    db_session.commit()
    monkeypatch.setattr(outbound_manager, "call", lambda *_args, **_kwargs: "Issue #12 is open")
    bundle = load_external_tools(workspace.id, user.id, db_session)
    progress = []
    bundle.on_step = lambda kind, detail: progress.append((kind, detail))
    with caplog.at_level("INFO", logger="notestack.tool_flow"):
        output = bundle.tools[0](query="private search words")
        bundle.tools[0](query="another private search")
    assert output.startswith("UNTRUSTED EXTERNAL DATA")
    assert "Issue #12 is open" in output
    assert [(source.connection, source.tool) for source in bundle.sources] == [("GitHub", "search_issues")]
    assert progress == [
        ("external_connect", "GitHub"),
        ("external_call", "GitHub / search_issues"),
        ("external_result", "GitHub / search_issues"),
        ("external_call", "GitHub / search_issues"),
        ("external_result", "GitHub / search_issues"),
    ]
    flow = "\n".join(record.getMessage() for record in caplog.records if record.name == "notestack.tool_flow")
    assert "MCP CALL START" in flow and "MCP CALL OK" in flow
    assert "args=object{query:string[20 chars]}" in flow and "result_chars=17" in flow
    assert "private search words" not in flow and "Issue #12 is open" not in flow


def test_external_adapter_exposes_and_calls_selected_write_tools(db_session, auth, monkeypatch):
    user = db_session.scalar(select(__import__("app.models", fromlist=["User"]).User))
    workspace = user.memberships[0].workspace
    row = OutboundMcpConnection(
        workspace_id=workspace.id, user_id=user.id, name="GitHub", server_url="https://mcp.example.com/mcp",
        auth_type="none", enabled=True, enabled_tools=["delete_repo"], discovered_tools=TOOLS, status="ready",
    )
    db_session.add(row)
    db_session.commit()
    called = {}

    def remote_call(_url, _token, tool, args):
        called.update(tool=tool, args=args)
        return '{"pages":[{"url":"https://app.notion.com/p/example?pvs=204"}]}'

    monkeypatch.setattr(outbound_manager, "call", remote_call)

    assert load_external_tools(
        workspace.id, user.id, db_session, provider_allowlist={"notion"}
    ).tools == []
    bundle = load_external_tools(workspace.id, user.id, db_session)
    assert len(bundle.tools) == 1
    assert bundle.tools[0]().endswith('{"pages":[{"url":"https://app.notion.com/p/example?pvs=204"}]}')
    assert called == {"tool": "delete_repo", "args": {}}
    assert bundle.sources[0].urls == ["https://app.notion.com/p/example?pvs=204"]


def test_write_resource_urls_are_explicit_safe_and_bounded():
    result = (
        '{"pages":[{"url":"https://app.notion.com/p/one?pvs=204"}],'
        '"docs":[{"html_url":"https://docs.example.com/two"}],'
        '"description":"ignore https://untrusted.example/in-prose",'
        '"bad":{"url":"javascript:alert(1)"}}'
    )
    assert _resource_urls(result) == [
        "https://app.notion.com/p/one?pvs=204",
        "https://docs.example.com/two",
    ]


def test_missing_write_resource_url_is_appended_as_a_clickable_link():
    url = "https://app.notion.com/p/408af5898bd781f1b776e0fe97582ecc?pvs=204"
    sources = [{"connection": "Notion", "tool": "notion-create-pages", "urls": [url]}]

    answer = research_module._append_external_resource_links("The Notion page is live.", sources)

    assert answer.endswith(f"[Open the result from Notion]({url})")
    assert research_module._append_external_resource_links(answer, sources) == answer


def test_external_action_calls_mcp_instead_of_archive(db_session, auth, monkeypatch):
    user = db_session.scalar(select(__import__("app.models", fromlist=["User"]).User))
    workspace = user.memberships[0].workspace
    row = OutboundMcpConnection(
        workspace_id=workspace.id, user_id=user.id, name="GitHub", server_url="https://mcp.example.com/mcp",
        auth_type="bearer", access_token_encrypted=encrypt("pat"),
        enabled=True, enabled_tools=["search_issues"], discovered_tools=TOOLS, status="ready",
    )
    db_session.add(row)
    db_session.commit()

    called = {}

    def remote_call(url, token, tool, arguments):
        called.update(url=url, token=token, tool=tool, arguments=arguments)
        return "repo result"

    monkeypatch.setattr(outbound_manager, "call", remote_call)
    bundle = load_external_tools(workspace.id, user.id, db_session)
    monkeypatch.setattr(
        research_module, "triage",
        lambda *a: research_module.Triage("external_action", "find GitHub issues", "quick", ""),
    )
    monkeypatch.setattr(research_module, "main_lm", lambda: SimpleNamespace(model="test"))

    @contextmanager
    def usage(_lm):
        yield SimpleNamespace(prompt_tokens=0, completion_tokens=0)

    monkeypatch.setattr(research_module, "track_usage", usage)

    class CallingReAct:
        def __init__(self, signature, tools, max_iters):
            self.signature, self.tools = signature, tools

        def __call__(self, **_inputs):
            answer = self.tools[0](query="login")
            return SimpleNamespace(answer=answer, citations=[], unsupported=False)

    monkeypatch.setattr(research_module.dspy, "ReAct", CallingReAct)
    corpus = SimpleNamespace(sync=lambda *_args: {})
    result = research_module.research(
        corpus, {}, "find GitHub issues", external_tools=bundle.tools, external_sources=bundle.sources,
    )

    assert called == {
        "url": "https://mcp.example.com/mcp", "token": "pat", "tool": "search_issues",
        "arguments": {"query": "login"},
    }
    assert result.external_sources == [{"connection": "GitHub", "tool": "search_issues"}]
    assert result.kind == "external_action"
    assert not result.citations and not result.unsupported
    assert "repo result" in result.text


def test_results_are_bounded_and_errors_do_not_look_successful(monkeypatch):
    monkeypatch.setattr(settings, "outbound_mcp_max_result_chars", 20)
    result = SimpleNamespace(structuredContent=None, content=[SimpleNamespace(text="x" * 100)], isError=False)
    assert _result_text(result) == "x" * 20
    with pytest.raises(OutboundMcpError):
        _result_text(SimpleNamespace(structuredContent=None, content=[SimpleNamespace(text="failed")], isError=True))


def test_widget_result_is_captured_without_putting_host_metadata_in_model_text(db_session, auth, monkeypatch):
    user = db_session.scalar(select(__import__("app.models", fromlist=["User"]).User))
    workspace = user.memberships[0].workspace
    widget_tool = {
        "name": "gallery", "description": "Show a gallery",
        "input_schema": {"type": "object", "properties": {}},
        "read_only": True, "destructive": False, "usable": True,
    }
    row = OutboundMcpConnection(
        workspace_id=workspace.id, user_id=user.id, name="Gallery", server_url="https://mcp.example.com/mcp",
        auth_type="none", enabled=True, enabled_tools=["gallery"], discovered_tools=[widget_tool], status="ready",
    )
    db_session.add(row)
    db_session.commit()
    monkeypatch.setattr(outbound_manager, "call", lambda *_args, **_kwargs: OutboundToolResult(
        'Template gallery shown.',
        {"content": [{"type": "text", "text": "Template gallery shown."}],
         "structuredContent": {"items": [{"id": "one"}]}, "isError": False},
        "ui://example/gallery",
    ))
    bundle = load_external_tools(workspace.id, user.id, db_session)
    observation = bundle.tools[0]()
    assert "Template gallery shown." in observation and "ui://example/gallery" not in observation
    assert bundle.widgets[0].as_dict() == {
        "connection_id": str(row.id), "connection": "Gallery", "tool": "gallery", "arguments": {},
        "resource_uri": "ui://example/gallery",
        "result": {"content": [{"type": "text", "text": "Template gallery shown."}],
                   "structuredContent": {"items": [{"id": "one"}]}, "isError": False},
    }


def test_widget_resource_and_tool_calls_are_proxied_with_connection_auth(client, auth, db_session, monkeypatch):
    user = db_session.scalar(select(__import__("app.models", fromlist=["User"]).User))
    workspace = user.memberships[0].workspace
    widget_tool = {
        "name": "gallery", "description": "Show a gallery",
        "input_schema": {"type": "object", "properties": {}},
        "read_only": True, "destructive": False, "usable": True,
    }
    row = OutboundMcpConnection(
        workspace_id=workspace.id, user_id=user.id, name="Gallery", server_url="https://mcp.example.com/mcp",
        auth_type="none", enabled=True, enabled_tools=["gallery"], discovered_tools=[widget_tool], status="ready",
    )
    db_session.add(row)
    db_session.commit()
    monkeypatch.setattr(outbound_manager, "discover", lambda *_args: [{
        **widget_tool, "ui_resource_uri": "ui://example/gallery",
    }])
    monkeypatch.setattr(outbound_manager, "read_resource", lambda *_args: {"contents": [{
        "uri": "ui://example/gallery", "mimeType": "text/html;profile=mcp-app",
        "text": "<html><body>Gallery</body></html>", "_meta": {"ui": {"prefersBorder": True}},
    }]})
    resource = client.get(f"/api/outbound-mcp/connections/{row.id}/widgets/gallery", headers=auth)
    assert resource.status_code == 200
    assert resource.json()["html"] == "<html><body>Gallery</body></html>"

    called = {}
    monkeypatch.setattr(outbound_manager, "call", lambda _url, _token, name, arguments: (
        called.update(name=name, arguments=arguments)
        or OutboundToolResult("ok", {"content": [{"type": "text", "text": "ok"}], "isError": False})
    ))
    result = client.post(
        f"/api/outbound-mcp/connections/{row.id}/widgets/tools/gallery",
        headers=auth,
        json={"arguments": {"selected": "one"}},
    )
    assert result.status_code == 200 and result.json()["content"][0]["text"] == "ok"
    assert called == {"name": "gallery", "arguments": {"selected": "one"}}


def test_canva_widget_is_only_shown_for_a_completed_design():
    assert not widget_is_displayable({
        "_meta": {"com.canva/embeddedEditorEnabled": False},
        "structuredContent": {"status": "pending"},
    })
    assert not widget_is_displayable(
        {"structuredContent": {"job_id": "job_1", "status": "pending"}},
        tool_name="create-design", server_url="https://mcp.canva.com/mcp",
    )
    for status in ("in_progress", "polled_too_early", "failed"):
        assert not widget_is_displayable(
            {"structuredContent": {"job_id": "job_1", "status": status}},
            tool_name="get-create-design-async-job", server_url="https://mcp.canva.com/mcp",
        )
    assert not widget_is_displayable(
        {"structuredContent": {"job_id": "job_1", "status": "completed"}},
        tool_name="get-create-design-async-job", server_url="https://mcp.canva.com/mcp",
    )
    assert widget_is_displayable(
        {"structuredContent": {
            "job_id": "job_1", "status": "completed",
            "design": {"id": "design_1", "edit_url": "https://www.canva.com/d/design_1"},
        }},
        tool_name="get-create-design-async-job", server_url="https://mcp.canva.com/mcp",
    )
    assert widget_is_displayable(
        {"content": [{"type": "text", "text": json.dumps({
            "job_id": "job_1", "status": "completed", "design": {"id": "design_1"},
        })}]},
        tool_name="get-create-design-async-job", server_url="https://mcp.canva.com/mcp",
    )
    assert widget_is_displayable({"_meta": {"ui": {"prefersBorder": True}}})


def test_protected_server_is_saved_for_oauth_instead_of_rejected(client, auth, monkeypatch):
    def protected(_url, _token=None):
        raise OutboundMcpError("authorization required", status_code=401, headers={
            "www-authenticate": 'Bearer resource_metadata="https://mcp.example.com/oauth-resource"',
        })

    prepared = {}
    monkeypatch.setattr(outbound_manager, "discover", protected)
    monkeypatch.setattr(
        "app.routers.outbound_mcp.prepare_authorization",
        lambda _db, row, headers: prepared.update(row=row.id, headers=headers),
    )
    response = client.post("/api/outbound-mcp/connections", headers=auth, json={
        "name": "Protected", "server_url": "https://mcp.example.com/mcp",
    })
    assert response.status_code == 201, response.text
    assert response.json()["auth_status"] == "authorization_required"
    assert response.json()["discovered_tools"] == []
    assert prepared["headers"]["www-authenticate"].startswith("Bearer")


def test_google_drive_tools_list_still_requires_oauth(client, auth, db_session, monkeypatch):
    monkeypatch.setattr(outbound_manager, "discover", lambda _url, _token=None: TOOLS)
    monkeypatch.setattr(settings, "google_client_id", "drive-agent-client")
    monkeypatch.setattr(settings, "google_client_secret", "drive-agent-secret")
    response = client.post("/api/outbound-mcp/connections", headers=auth, json={
        "name": "Google Drive", "server_url": "https://drivemcp.googleapis.com/mcp/v1",
    })
    assert response.status_code == 201, response.text
    assert response.json()["auth_status"] == "authorization_required"
    assert response.json()["status"] == "error"
    assert len(response.json()["discovered_tools"]) == len(TOOLS)
    saved = db_session.scalar(select(OutboundMcpConnection))
    assert saved.authorization_issuer == "https://accounts.google.com"
    oauth_client = db_session.scalar(select(OutboundMcpOAuthClient))
    assert oauth_client.client_id == "drive-agent-client"


def test_generic_server_with_public_tool_catalog_uses_standard_oauth_metadata(
    client, auth, db_session, monkeypatch,
):
    monkeypatch.setattr(outbound_manager, "discover", lambda _url, _token=None: TOOLS)
    documents = {
        "https://files.example.com/.well-known/oauth-protected-resource/mcp": {
            "resource": "https://files.example.com/mcp",
            "authorization_servers": ["https://login.example.com"],
            "scopes_supported": ["files.read"],
        },
        "https://login.example.com/.well-known/oauth-authorization-server": {
            "issuer": "https://login.example.com",
            "authorization_endpoint": "https://login.example.com/authorize",
            "token_endpoint": "https://login.example.com/token",
            "registration_endpoint": "https://login.example.com/register",
        },
    }

    def metadata(url, _label, _timeout=None):
        if url not in documents:
            raise OAuthFlowError("not found")
        return documents[url]

    monkeypatch.setattr(oauth_service, "_get_json", metadata)
    monkeypatch.setattr(oauth_service, "_post_json", lambda *_args: {"client_id": "dynamic-client"})
    response = client.post("/api/outbound-mcp/connections", headers=auth, json={
        "name": "Files", "server_url": "https://files.example.com/mcp",
    })
    assert response.status_code == 201, response.text
    assert response.json()["auth_status"] == "authorization_required"
    saved_client = db_session.scalar(select(OutboundMcpOAuthClient))
    assert saved_client.registration_type == "dynamic"
    assert saved_client.client_id == "dynamic-client"


def test_published_oauth_metadata_errors_are_not_treated_as_public(db_session, auth, monkeypatch):
    user = db_session.scalar(select(__import__("app.models", fromlist=["User"]).User))
    workspace = user.memberships[0].workspace
    row = OutboundMcpConnection(
        workspace_id=workspace.id, user_id=user.id, name="Broken OAuth",
        server_url="https://files.example.com/mcp", auth_type="none", auth_status="not_required",
        enabled=True, enabled_tools=[], discovered_tools=TOOLS, status="ready",
    )
    db_session.add(row)
    db_session.commit()

    def metadata(url, _label, _timeout=None):
        if "oauth-protected-resource" in url:
            return {
                "resource": row.server_url,
                "authorization_servers": ["https://login.example.com"],
            }
        raise OAuthFlowError("authorization server metadata is invalid")

    monkeypatch.setattr(oauth_service, "_get_json", metadata)
    with pytest.raises(OAuthFlowError, match="authorization server metadata"):
        oauth_service.probe_authorization(db_session, row)


def test_existing_unauthenticated_google_drive_connection_is_repaired(client, auth, db_session, monkeypatch):
    monkeypatch.setattr(settings, "google_client_id", "drive-agent-client")
    monkeypatch.setattr(settings, "google_client_secret", "drive-agent-secret")
    user = db_session.scalar(select(__import__("app.models", fromlist=["User"]).User))
    workspace = user.memberships[0].workspace
    row = OutboundMcpConnection(
        workspace_id=workspace.id, user_id=user.id, name="gdrive",
        server_url="https://drivemcp.googleapis.com/mcp/v1", auth_type="none", auth_status="not_required",
        enabled=True, enabled_tools=["search_issues"], discovered_tools=TOOLS, status="ready",
    )
    db_session.add(row)
    db_session.commit()
    response = client.get("/api/outbound-mcp/connections", headers=auth)
    assert response.status_code == 200
    assert response.json()[0]["auth_status"] == "authorization_required"
    assert response.json()[0]["status"] == "error"


def test_oauth_discovery_uses_challenge_and_issuer_metadata(monkeypatch):
    documents = {
        "https://mcp.example.com/oauth-resource": {
            "resource": "https://mcp.example.com/mcp", "authorization_servers": ["https://login.example.com"],
            "scopes_supported": ["files.read"],
        },
        "https://login.example.com/.well-known/oauth-authorization-server": {
            "issuer": "https://login.example.com", "authorization_endpoint": "https://login.example.com/authorize",
            "token_endpoint": "https://login.example.com/token",
        },
    }
    monkeypatch.setattr(oauth_service, "_get_json", lambda url, _label, _timeout=None: documents[url])
    result = oauth_service.discover_authorization("https://mcp.example.com/mcp", {
        "www-authenticate": 'Bearer resource_metadata="https://mcp.example.com/oauth-resource"',
    })
    assert result.resource == "https://mcp.example.com/mcp"
    assert result.issuer == "https://login.example.com"
    assert result.resource_metadata["scopes_supported"] == ["files.read"]


def test_static_oauth_clients_match_exact_issuer_and_resource(db_session, monkeypatch):
    monkeypatch.setattr(settings, "outbound_mcp_oauth_clients_json", """[{
        "issuer": "https://login.example.com",
        "resource": "https://mcp.example.com/mcp",
        "client_id": "registered-client",
        "client_secret": "registered-secret",
        "default_scopes": ["files.read"]
    }]""")
    discovery = oauth_service.OAuthDiscovery(
        resource="https://mcp.example.com/mcp", issuer="https://login.example.com",
        resource_metadata={"scopes_supported": ["files.read"]},
        authorization_metadata={
            "issuer": "https://login.example.com", "authorization_endpoint": "https://login.example.com/auth",
            "token_endpoint": "https://login.example.com/token",
        },
    )
    client = oauth_service.resolve_oauth_client(db_session, discovery)
    assert client.client_id == "registered-client"
    assert decrypt(client.client_secret_encrypted) == "registered-secret"
    assert "client_secret" not in client.metadata_json["profile"]

    other_resource = oauth_service.OAuthDiscovery(
        resource="https://different.example.com/mcp", issuer=discovery.issuer,
        resource_metadata={}, authorization_metadata=discovery.authorization_metadata,
    )
    with pytest.raises(OAuthFlowError, match="pre-registered client"):
        oauth_service.resolve_oauth_client(db_session, other_resource)


def test_dynamic_oauth_client_is_registered_again_when_callback_changes(db_session, monkeypatch):
    discovery = oauth_service.OAuthDiscovery(
        resource="https://mcp.example.com/mcp", issuer="https://login.example.com",
        resource_metadata={"scopes_supported": ["files.read"]},
        authorization_metadata={
            "issuer": "https://login.example.com",
            "authorization_endpoint": "https://login.example.com/authorize",
            "token_endpoint": "https://login.example.com/token",
            "registration_endpoint": "https://login.example.com/register",
        },
    )
    registrations = []

    def register(_url, metadata, _label):
        registrations.append(metadata)
        return {"client_id": f"client-{len(registrations)}", "redirect_uris": metadata["redirect_uris"]}

    monkeypatch.setattr(oauth_service, "_post_json", register)
    monkeypatch.setattr(settings, "outbound_mcp_oauth_callback_uri", "https://old.example.com/oauth/callback")
    old = oauth_service.resolve_oauth_client(db_session, discovery)
    monkeypatch.setattr(settings, "outbound_mcp_oauth_callback_uri", "http://localhost:8000/oauth/callback")
    current = oauth_service.resolve_oauth_client(db_session, discovery)

    assert old.id != current.id
    assert old.redirect_uri == "https://old.example.com/oauth/callback"
    assert current.redirect_uri == "http://localhost:8000/oauth/callback"
    assert [item["redirect_uris"] for item in registrations] == [
        ["https://old.example.com/oauth/callback"], ["http://localhost:8000/oauth/callback"],
    ]


def test_pkce_callback_encrypts_grant_and_refreshes_at_call_time(
    db_session, session_factory, auth, monkeypatch,
):
    user = db_session.scalar(select(__import__("app.models", fromlist=["User"]).User))
    workspace = user.memberships[0].workspace
    connection = OutboundMcpConnection(
        workspace_id=workspace.id, user_id=user.id, name="Files", server_url="https://mcp.example.com/mcp",
        auth_type="none", auth_status="authorization_required", enabled=True, enabled_tools=[],
        discovered_tools=[], status="error", canonical_resource="https://mcp.example.com/mcp",
        authorization_issuer="https://login.example.com",
    )
    db_session.add(connection)
    db_session.flush()
    oauth_client = OutboundMcpOAuthClient(
        issuer="https://login.example.com", resource="https://mcp.example.com/mcp",
        redirect_uri=settings.outbound_mcp_oauth_callback_url, registration_type="dynamic",
        client_id="client-123", metadata_json={
            "authorization_server": {
                "issuer": "https://login.example.com",
                "authorization_endpoint": "https://login.example.com/authorize",
                "token_endpoint": "https://login.example.com/token",
            },
            "protected_resource": {"resource": "https://mcp.example.com/mcp", "scopes_supported": ["files.read"]},
        },
    )
    db_session.add(oauth_client)
    db_session.commit()
    monkeypatch.setattr(oauth_service, "_check_oauth_url", lambda _url: None)

    authorization_url = start_authorization(db_session, connection)
    params = parse_qs(urlsplit(authorization_url).query)
    state = params["state"][0]
    assert params["code_challenge_method"] == ["S256"]
    assert "code_verifier" not in params
    attempt = db_session.scalar(select(OutboundMcpAuthAttempt))
    assert attempt.state_hash != state
    assert decrypt(attempt.pkce_verifier_encrypted)

    exchanges = []

    def token_exchange(_url, data, _label):
        exchanges.append(data)
        if data["grant_type"] == "authorization_code":
            return {"access_token": "access-one", "refresh_token": "refresh-one", "expires_in": 1,
                    "scope": "files.read", "token_type": "Bearer"}
        return {"access_token": "access-two", "refresh_token": "refresh-two", "expires_in": 3600,
                "scope": "files.read", "token_type": "Bearer"}

    monkeypatch.setattr(oauth_service, "_post_form", token_exchange)
    finished = finish_authorization(db_session, state, "one-time-code")
    db_session.commit()
    grant = db_session.scalar(select(OutboundMcpGrant))
    assert finished.auth_type == "oauth" and finished.auth_status == "ready"
    assert grant.access_token_encrypted != "access-one"
    assert decrypt(grant.access_token_encrypted) == "access-one"
    assert decrypt(grant.refresh_token_encrypted) == "refresh-one"
    assert exchanges[0]["code_verifier"] == decrypt(attempt.pkce_verifier_encrypted)
    with pytest.raises(OAuthFlowError, match="invalid or expired"):
        finish_authorization(db_session, state, "replayed-code")

    grant.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    db_session.commit()
    monkeypatch.setattr(oauth_service, "SessionLocal", session_factory)
    assert access_token_for(connection.id, workspace.id, user.id) == "access-two"
    db_session.expire_all()
    grant = db_session.scalar(select(OutboundMcpGrant))
    assert decrypt(grant.refresh_token_encrypted) == "refresh-two"
    assert exchanges[-1]["grant_type"] == "refresh_token"


def test_oauth_http_flow_sets_browser_binding_and_discovers_tools(client, auth, db_session, monkeypatch):
    user = db_session.scalar(select(__import__("app.models", fromlist=["User"]).User))
    workspace = user.memberships[0].workspace
    connection = OutboundMcpConnection(
        workspace_id=workspace.id, user_id=user.id, name="Drive", server_url="https://mcp.example.com/mcp",
        auth_type="none", auth_status="authorization_required", enabled=True, enabled_tools=[],
        discovered_tools=[], status="error", canonical_resource="https://mcp.example.com/mcp",
        authorization_issuer="https://login.example.com",
    )
    db_session.add(connection)
    db_session.flush()
    db_session.add(OutboundMcpOAuthClient(
        issuer="https://login.example.com", resource="https://mcp.example.com/mcp",
        redirect_uri=settings.outbound_mcp_oauth_callback_url, registration_type="dynamic",
        client_id="web-client", metadata_json={
            "authorization_server": {
                "issuer": "https://login.example.com",
                "authorization_endpoint": "https://login.example.com/authorize",
                "token_endpoint": "https://login.example.com/token",
            },
            "protected_resource": {"resource": "https://mcp.example.com/mcp"},
        },
    ))
    db_session.commit()
    monkeypatch.setattr(oauth_service, "_check_oauth_url", lambda _url: None)
    monkeypatch.setattr(oauth_service, "_post_form", lambda *_args: {
        "access_token": "oauth-access", "refresh_token": "oauth-refresh", "expires_in": 3600,
    })
    monkeypatch.setattr(outbound_manager, "discover", lambda _url, token=None: TOOLS if token == "oauth-access" else [])

    started = client.post(f"/api/outbound-mcp/connections/{connection.id}/oauth/start", headers=auth, json={})
    assert started.status_code == 200, started.text
    assert "ns_outbound_mcp_state=" in started.headers["set-cookie"]
    state = parse_qs(urlsplit(started.json()["authorization_url"]).query)["state"][0]
    callback = client.get(
        "/api/outbound-mcp/oauth/callback", params={"state": state, "code": "authorization-code"},
        follow_redirects=False,
    )
    assert callback.status_code == 302
    assert "mcp_oauth=connected" in callback.headers["location"]
    db_session.expire_all()
    saved = db_session.get(OutboundMcpConnection, connection.id)
    assert saved.auth_type == "oauth" and saved.auth_status == "ready"
    assert [tool["name"] for tool in saved.discovered_tools] == ["search_issues", "delete_repo"]
    assert saved.enabled_tools == ["search_issues"]


def test_oauth_grant_survives_google_resource_403(client, auth, db_session, monkeypatch):
    user = db_session.scalar(select(__import__("app.models", fromlist=["User"]).User))
    workspace = user.memberships[0].workspace
    connection = OutboundMcpConnection(
        workspace_id=workspace.id, user_id=user.id, name="Drive", provider="google",
        server_url="https://drivemcp.googleapis.com/mcp/v1", auth_type="none",
        auth_status="authorization_required", enabled=True, enabled_tools=[], discovered_tools=TOOLS, status="error",
    )
    oauth_client = OutboundMcpOAuthClient(
        issuer="https://accounts.google.com", resource=connection.server_url,
        redirect_uri=settings.outbound_mcp_oauth_callback_url, registration_type="static",
        client_id="google-client", metadata_json={},
    )
    db_session.add_all((connection, oauth_client))
    db_session.commit()

    def finish(db, _state, _code):
        row = db.get(OutboundMcpConnection, connection.id)
        row.auth_type, row.auth_status, row.status = "oauth", "ready", "ready"
        db.add(OutboundMcpGrant(
            connection_id=row.id, workspace_id=row.workspace_id, user_id=row.user_id,
            oauth_client_id=oauth_client.id, issuer=oauth_client.issuer, resource=row.server_url,
            access_token_encrypted=encrypt("issued-token"), scopes=["drive.readonly", "drive.file"],
        ))
        db.flush()
        return row

    monkeypatch.setattr("app.routers.outbound_mcp.finish_authorization", finish)
    monkeypatch.setattr(
        outbound_manager, "discover",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(OutboundMcpError("HTTP 403", status_code=403)),
    )
    client.cookies.set("ns_outbound_mcp_state", "valid-state", path="/api/outbound-mcp/oauth")
    response = client.get(
        "/api/outbound-mcp/oauth/callback", params={"state": "valid-state", "code": "one-time-code"},
        follow_redirects=False,
    )
    assert response.status_code == 302
    db_session.expire_all()
    saved = db_session.get(OutboundMcpConnection, connection.id)
    grant = db_session.scalar(select(OutboundMcpGrant).where(OutboundMcpGrant.connection_id == connection.id))
    assert grant is not None
    assert saved.auth_type == "oauth" and saved.auth_status == "configuration_error"
    assert "Drive MCP API" in saved.last_error


def test_icon_domain_resolution_and_fetch_failure(monkeypatch):
    from app.mcp_client import icon

    assert icon.brand_domain("https://mcp.linear.app/mcp") == "linear.app"
    assert icon.brand_domain("https://api.githubcopilot.com/mcp/") == "github.com"
    assert icon.brand_domain("https://gmailmcp.googleapis.com/mcp/v1") == "gmail.com"
    assert icon.brand_domain("https://tools.example.co.uk/mcp") == "example.co.uk"

    def boom(*args, **kwargs):
        raise RuntimeError("offline")

    monkeypatch.setattr(icon.httpx, "get", boom)
    assert icon.fetch_server_icon("https://mcp.linear.app/mcp") is None


def test_every_connection_gets_a_logo(monkeypatch):
    from app.mcp_client import icon

    monkeypatch.setattr(icon, "fetch_server_icon", lambda url: None)
    generated = icon.ensure_icon("https://mcp.linear.app/mcp", "Linear")
    assert generated.startswith("data:image/svg+xml;base64,")
    monkeypatch.setattr(icon, "fetch_server_icon", lambda url: "data:image/png;base64,AAAA")
    # A generated placeholder is upgraded once the real logo can be fetched; a real one is never replaced.
    assert icon.ensure_icon("https://mcp.linear.app/mcp", "Linear", generated) == "data:image/png;base64,AAAA"
    assert icon.ensure_icon("https://x.dev/mcp", "X", "data:image/png;base64,REAL") == "data:image/png;base64,REAL"


def test_catalog_hides_slack_and_canva(client, auth, monkeypatch):
    monkeypatch.setattr("app.mcp_client.catalog.fetch_server_icon", lambda url: None)
    monkeypatch.setattr("app.routers.outbound_mcp.manager.discover", lambda url, token=None: TOOLS)
    entries = client.get("/api/outbound-mcp/catalog", headers=auth).json()
    assert [entry["name"] for entry in entries] == ["B2V", "Notion", "Zapier"]
    notion = next(e for e in entries if e["name"] == "Notion")
    assert notion["icon_url"].startswith("data:image/svg+xml") and notion["server_url"].startswith("https://")
    client.post("/api/outbound-mcp/connections", headers=auth, json={"name": "Notion", "server_url": notion["server_url"]})
    assert "Notion" in [e["name"] for e in client.get("/api/outbound-mcp/catalog", headers=auth).json()]


def test_a_request_naming_a_connected_app_is_not_taken_by_the_builtin_create_flow():
    from app.mcp_client.tools import _aliases
    from app.pipeline.research import names_external_app

    aliases = _aliases("B2V", "https://api.blog2video.app/mcp/sse")
    assert aliases == {"b2v", "blog2video"}
    assert names_external_app("generate a video using blog2video plugin for my support bot post", aliases) == "blog2video"
    assert names_external_app("make a video with B2V from my pricing post", aliases) == "b2v"
    assert names_external_app("make a video of my pricing posts", aliases) is None
    assert names_external_app("what did I write about blog2video?", aliases) is None
