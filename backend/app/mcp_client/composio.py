"""Composio managed authentication and user-scoped MCP sessions.

The project API key never leaves the backend. Composio stores provider credentials; NoteStack uses the same stable
external user id for a writer across Gmail and Outlook, and pins every MCP session to that writer's active account.
"""

import uuid
from typing import Any

from composio import SESSION_PRESET_DIRECT_TOOLS, Composio

from app.config import settings

MCP_PROVIDER = "composio"
SUPPORTED_EMAIL_APPS = {
    "gmail": {"name": "Gmail", "description": "Send, draft, reply to, and search Gmail"},
    "outlook": {"name": "Outlook", "description": "Send, draft, reply to, and search Outlook mail"},
}


class ComposioError(RuntimeError):
    pass


def configured() -> bool:
    return bool(settings.composio_api_key)


def require_configured() -> None:
    if not configured():
        raise ComposioError(
            "Composio is not configured. Set COMPOSIO_API_KEY on the backend."
        )


def external_user_id(workspace_id: uuid.UUID | str, user_id: uuid.UUID | str) -> str:
    """Keep the same human isolated across workspaces as well as across user accounts."""
    return f"notestack:{workspace_id}:{user_id}"


def _client() -> Composio:
    require_configured()
    return Composio(api_key=settings.composio_api_key)


def _message(exc: Exception, fallback: str) -> str:
    text = " ".join(str(exc).split())
    return text[:300] if text else fallback


def connect_link(workspace_id: uuid.UUID | str, user_id: uuid.UUID | str, app_slug: str, *,
                 callback_url: str) -> str:
    if app_slug not in SUPPORTED_EMAIL_APPS:
        raise ComposioError("That Composio email provider is not supported.")
    try:
        session = _client().sessions.create(
            user_id=external_user_id(workspace_id, user_id),
            toolkits=[app_slug],
        )
        request = session.authorize(app_slug, callback_url=callback_url)
    except Exception as exc:
        raise ComposioError(_message(exc, "Composio could not start the account connection.")) from exc
    if not request.redirect_url:
        raise ComposioError("Composio returned no account connection link.")
    return request.redirect_url


def _active_accounts(workspace_id: uuid.UUID | str, user_id: uuid.UUID | str, app_slug: str) -> list[Any]:
    if app_slug not in SUPPORTED_EMAIL_APPS:
        raise ComposioError("That Composio email provider is not supported.")
    try:
        response = _client().connected_accounts.list(
            user_ids=[external_user_id(workspace_id, user_id)],
            toolkit_slugs=[app_slug],
            statuses=["ACTIVE"],
        )
    except Exception as exc:
        raise ComposioError(_message(exc, "Composio could not check the account connection.")) from exc
    return list(response.items or [])


def active_account(workspace_id: uuid.UUID | str, user_id: uuid.UUID | str, app_slug: str) -> Any:
    accounts = _active_accounts(workspace_id, user_id, app_slug)
    if not accounts:
        raise ComposioError("Finish connecting this account in Composio, then try again.")
    return accounts[0]


def _find_display_name(value: Any) -> str | None:
    if hasattr(value, "model_dump"):
        value = value.model_dump()
    if isinstance(value, dict):
        for key in ("displayName", "display_name", "email", "username"):
            label = value.get(key)
            if isinstance(label, str) and label.strip():
                return label.strip()[:250]
        for nested in value.values():
            if label := _find_display_name(nested):
                return label
    elif isinstance(value, list | tuple):
        for nested in value:
            if label := _find_display_name(nested):
                return label
    return None


def account_label(account: Any, fallback: str) -> str:
    alias = getattr(account, "alias", None)
    return (str(alias).strip() if alias else None) or _find_display_name(getattr(account, "state", None)) or fallback


def mcp_session(workspace_id: uuid.UUID | str, user_id: uuid.UUID | str, app_slug: str, *,
                tool_names: list[str] | None = None) -> tuple[str, dict[str, str]]:
    """Create a short-lived direct-tools MCP session pinned to the writer's active provider account."""
    account = active_account(workspace_id, user_id, app_slug)
    options: dict[str, Any] = {
        "user_id": external_user_id(workspace_id, user_id),
        "toolkits": [app_slug],
        "connected_accounts": {app_slug: [account.id]},
        "session_preset": SESSION_PRESET_DIRECT_TOOLS,
        "mcp": True,
    }
    if tool_names is not None:
        options["tools"] = {app_slug: {"enable": list(dict.fromkeys(tool_names))}}
    try:
        session = _client().sessions.create(**options)
    except Exception as exc:
        raise ComposioError(_message(exc, "Composio could not create an MCP session.")) from exc
    url = str(session.mcp.url or "")
    headers = {str(key): str(value) for key, value in (session.mcp.headers or {}).items() if value is not None}
    if not url:
        raise ComposioError("Composio returned no MCP session URL.")
    return url, headers


def disconnect(workspace_id: uuid.UUID | str, user_id: uuid.UUID | str, app_slug: str) -> None:
    """Best-effort remote credential deletion for one writer's provider connection."""
    if not configured() or app_slug not in SUPPORTED_EMAIL_APPS:
        return
    try:
        accounts = _active_accounts(workspace_id, user_id, app_slug)
        client = _client()
        for account in accounts:
            client.connected_accounts.delete(account.id, revoke_on_delete=True)
    except Exception:
        # Removing the local connection must not strand the user because Composio's control plane is unavailable.
        return
