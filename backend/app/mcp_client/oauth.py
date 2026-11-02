"""OAuth 2.1 authorization and token lifecycle for remote MCP servers.

The generic path follows MCP authorization discovery: WWW-Authenticate -> protected-resource metadata ->
authorization-server metadata -> CIMD/DCR. Provider profiles are only used where an issuer needs extra parameters or
a pre-registered client; they are selected from the discovered issuer/resource, not from a user-entered display name.
"""

import base64
import hashlib
import json
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from urllib.parse import urlencode, urlsplit

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.db import SessionLocal
from app.models import (
    OutboundMcpAuthAttempt,
    OutboundMcpConnection,
    OutboundMcpGrant,
    OutboundMcpOAuthClient,
)
from app.services.crypto import decrypt, encrypt
from app.services.safe_http import check_url, safe_get

ATTEMPT_TTL = timedelta(minutes=10)
REFRESH_EARLY = timedelta(minutes=2)
MAX_METADATA_BYTES = 1_000_000

# Google Workspace deliberately allows unauthenticated tools/list, so no 401 challenge is available during setup.
# Match the complete canonical resource, not a hostname or display name. More Workspace products can be added here
# with their documented scopes without changing the generic OAuth discovery path.
GOOGLE_WORKSPACE_RESOURCES = {
    "https://drivemcp.googleapis.com/mcp/v1": [
        "https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/drive.file",
    ],
}


class OAuthFlowError(RuntimeError):
    def __init__(self, message: str, *, code: str | None = None, status_code: int | None = None):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


class OAuthMetadataNotFound(OAuthFlowError):
    """No protected-resource document was found; anonymous access may genuinely be supported."""


@dataclass(frozen=True)
class OAuthDiscovery:
    resource: str
    issuer: str
    resource_metadata: dict
    authorization_metadata: dict
    provider: str | None = None


def _aware(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value


def _json_response(response: httpx.Response, label: str) -> dict:
    response.raise_for_status()
    if len(response.content) > MAX_METADATA_BYTES:
        raise OAuthFlowError(f"{label} is too large.")
    try:
        value = response.json()
    except (json.JSONDecodeError, ValueError) as exc:
        raise OAuthFlowError(f"{label} did not return JSON.") from exc
    if not isinstance(value, dict):
        raise OAuthFlowError(f"{label} returned an invalid document.")
    return value


def _check_oauth_url(url: str) -> None:
    parts = urlsplit(url)
    if parts.scheme != "https" and not (settings.outbound_mcp_allow_http and parts.scheme == "http"):
        raise OAuthFlowError("OAuth endpoints must use HTTPS.")
    check_url(url)


def _get_json(url: str, label: str, timeout: float | None = None) -> dict:
    try:
        _check_oauth_url(url)
        return _json_response(safe_get(url, timeout=timeout or settings.outbound_mcp_connect_timeout_seconds,
                                       headers={"Accept": "application/json"}), label)
    except (httpx.HTTPError, ValueError) as exc:
        raise OAuthFlowError(f"Could not read {label}: {exc}") from exc


def _post_form(url: str, data: dict[str, str], label: str) -> dict:
    try:
        _check_oauth_url(url)
        response = httpx.post(url, data=data, headers={"Accept": "application/json"}, follow_redirects=False,
                              timeout=settings.outbound_mcp_connect_timeout_seconds)
        return _json_response(response, label)
    except (httpx.HTTPError, ValueError) as exc:
        detail = ""
        code = None
        status_code = None
        response = getattr(exc, "response", None)
        if isinstance(response, httpx.Response):
            status_code = response.status_code
            try:
                body = response.json()
                code = str(body.get("error") or "") or None
                detail = str(body.get("error_description") or body.get("error") or "")
            except (ValueError, AttributeError):
                pass
        raise OAuthFlowError(
            f"{label} failed{': ' + detail if detail else '.'}", code=code, status_code=status_code
        ) from exc


def _post_json(url: str, data: dict, label: str) -> dict:
    try:
        _check_oauth_url(url)
        response = httpx.post(url, json=data, headers={"Accept": "application/json"}, follow_redirects=False,
                              timeout=settings.outbound_mcp_connect_timeout_seconds)
        return _json_response(response, label)
    except (httpx.HTTPError, ValueError) as exc:
        raise OAuthFlowError(f"{label} failed.") from exc


def _challenge_parameter(header: str, name: str) -> str | None:
    # Challenge parameter values are quoted strings in MCP examples. This also accepts an unquoted URI/scope token.
    import re
    match = re.search(rf"(?:^|[,\s]){name}\s*=\s*(?:\"([^\"]+)\"|([^,\s]+))", header, re.IGNORECASE)
    return (match.group(1) or match.group(2)) if match else None


def _protected_resource_candidates(server_url: str, challenge: str | None) -> list[str]:
    candidates: list[str] = []
    if challenge:
        metadata_url = _challenge_parameter(challenge, "resource_metadata")
        if metadata_url:
            candidates.append(metadata_url)
    parts = urlsplit(server_url)
    path = parts.path.rstrip("/")
    if path:
        candidates.append(f"{parts.scheme}://{parts.netloc}/.well-known/oauth-protected-resource{path}")
    candidates.append(f"{parts.scheme}://{parts.netloc}/.well-known/oauth-protected-resource")
    return list(dict.fromkeys(candidates))


def _authorization_metadata_candidates(issuer: str) -> list[str]:
    parts = urlsplit(issuer.rstrip("/"))
    path = parts.path.rstrip("/")
    oauth = f"{parts.scheme}://{parts.netloc}/.well-known/oauth-authorization-server{path}"
    oidc = f"{issuer.rstrip('/')}/.well-known/openid-configuration"
    return list(dict.fromkeys((oauth, oidc)))


def _first_document(urls: list[str], label: str, timeout: float | None = None) -> dict:
    errors: list[str] = []
    for url in urls:
        try:
            return _get_json(url, label, timeout)
        except OAuthFlowError as exc:
            errors.append(str(exc))
    raise OAuthFlowError(errors[-1] if errors else f"No {label} URL was available.")


def _profiles() -> list[dict]:
    if not settings.outbound_mcp_oauth_clients_json.strip():
        return []
    try:
        profiles = json.loads(settings.outbound_mcp_oauth_clients_json)
    except json.JSONDecodeError as exc:
        raise OAuthFlowError("OUTBOUND_MCP_OAUTH_CLIENTS_JSON is not valid JSON.") from exc
    if not isinstance(profiles, list):
        raise OAuthFlowError("OUTBOUND_MCP_OAUTH_CLIENTS_JSON must be a JSON list.")
    return [profile for profile in profiles if isinstance(profile, dict)]


def _resource_profile(server_url: str) -> dict | None:
    resource = server_url.rstrip("/")
    return next((profile for profile in _profiles()
                 if str(profile.get("resource", "")).rstrip("/") == resource), None)


def _fallback_discovery(server_url: str) -> OAuthDiscovery | None:
    resource = server_url.rstrip("/")
    if resource in GOOGLE_WORKSPACE_RESOURCES:
        return OAuthDiscovery(
            resource=resource,
            issuer="https://accounts.google.com",
            resource_metadata={
                "resource": resource,
                "authorization_servers": ["https://accounts.google.com"],
                "scopes_supported": GOOGLE_WORKSPACE_RESOURCES[resource],
            },
            authorization_metadata={
                "issuer": "https://accounts.google.com",
                "authorization_endpoint": "https://accounts.google.com/o/oauth2/v2/auth",
                "token_endpoint": "https://oauth2.googleapis.com/token",
                "revocation_endpoint": "https://oauth2.googleapis.com/revoke",
            },
            provider="google",
        )
    profile = _resource_profile(resource)
    if not profile or not profile.get("issuer"):
        return None
    issuer = str(profile["issuer"]).rstrip("/")
    if profile.get("authorization_endpoint") and profile.get("token_endpoint"):
        authorization_metadata = {
            "issuer": issuer,
            "authorization_endpoint": profile["authorization_endpoint"],
            "token_endpoint": profile["token_endpoint"],
            **({"revocation_endpoint": profile["revocation_endpoint"]} if profile.get("revocation_endpoint") else {}),
        }
    else:
        authorization_metadata = _first_document(_authorization_metadata_candidates(issuer),
                                                 "OAuth authorization-server metadata")
    return OAuthDiscovery(
        resource=resource, issuer=issuer,
        resource_metadata={
            "resource": resource, "authorization_servers": [issuer],
            "scopes_supported": profile.get("default_scopes") or [],
        },
        authorization_metadata=authorization_metadata,
        provider=str(profile.get("provider") or "") or None,
    )


def discover_authorization(server_url: str, challenge_headers: dict[str, str] | None = None,
                           metadata_timeout: float | None = None) -> OAuthDiscovery:
    challenge_headers = challenge_headers or {}
    challenge = challenge_headers.get("www-authenticate") or challenge_headers.get("WWW-Authenticate")
    if not challenge:
        fallback = _fallback_discovery(server_url)
        if fallback:
            return fallback
    try:
        resource_metadata = _first_document(_protected_resource_candidates(server_url, challenge),
                                            "OAuth protected-resource metadata", metadata_timeout)
    except OAuthFlowError as exc:
        fallback = _fallback_discovery(server_url)
        if fallback:
            return fallback
        raise OAuthMetadataNotFound("The server did not publish OAuth protected-resource metadata.") from exc
    resource = str(resource_metadata.get("resource") or server_url).rstrip("/")
    servers = resource_metadata.get("authorization_servers") or []
    if not isinstance(servers, list) or not servers:
        raise OAuthFlowError("The MCP server did not advertise an OAuth authorization server.")
    issuer = str(servers[0]).rstrip("/")
    authorization_metadata = _first_document(_authorization_metadata_candidates(issuer),
                                             "OAuth authorization-server metadata", metadata_timeout)
    discovered_issuer = str(authorization_metadata.get("issuer") or issuer).rstrip("/")
    if discovered_issuer != issuer:
        raise OAuthFlowError("OAuth issuer metadata did not match the advertised issuer.")
    provider = "google" if issuer == "https://accounts.google.com" else None
    return OAuthDiscovery(resource, issuer, resource_metadata, authorization_metadata, provider)


def _client_metadata() -> dict:
    return {
        "client_name": settings.app_name,
        "redirect_uris": [settings.outbound_mcp_oauth_callback_url],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    }


def client_metadata_document() -> dict:
    """Public CIMD document. Configure its absolute URL only when this API is publicly reachable over HTTPS."""
    return _client_metadata()


def _configured_profile(discovery: OAuthDiscovery) -> dict | None:
    for profile in _profiles():
        if (str(profile.get("issuer", "")).rstrip("/") == discovery.issuer
                and str(profile.get("resource", "")).rstrip("/") == discovery.resource):
            return profile
    return None


def resolve_oauth_client(db: Session, discovery: OAuthDiscovery) -> OutboundMcpOAuthClient:
    redirect_uri = settings.outbound_mcp_oauth_callback_url
    existing = db.scalar(select(OutboundMcpOAuthClient).where(
        OutboundMcpOAuthClient.issuer == discovery.issuer,
        OutboundMcpOAuthClient.resource == discovery.resource,
        OutboundMcpOAuthClient.redirect_uri == redirect_uri,
    ))
    if existing:
        return existing

    metadata = dict(discovery.authorization_metadata)
    saved_metadata = {"authorization_server": metadata, "protected_resource": discovery.resource_metadata}
    profile = _configured_profile(discovery)
    if profile:
        client_id = str(profile.get("client_id") or "")
        if not client_id:
            raise OAuthFlowError("The configured OAuth client profile has no client_id.")
        safe_profile = {key: value for key, value in profile.items() if key != "client_secret"}
        row = OutboundMcpOAuthClient(
            issuer=discovery.issuer, resource=discovery.resource, redirect_uri=redirect_uri,
            registration_type="static",
            client_id=client_id, client_secret_encrypted=encrypt(profile.get("client_secret")),
            metadata_json={**saved_metadata, "profile": safe_profile},
        )
    elif discovery.provider == "google":
        client_id = settings.google_mcp_oauth_client_id
        if not client_id:
            raise OAuthFlowError(
                "Google Drive OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET."
            )
        row = OutboundMcpOAuthClient(
            issuer=discovery.issuer, resource=discovery.resource, redirect_uri=redirect_uri,
            registration_type="static",
            client_id=client_id, client_secret_encrypted=encrypt(settings.google_mcp_oauth_client_secret),
            metadata_json=saved_metadata,
        )
    elif settings.outbound_mcp_client_metadata_url and metadata.get("client_id_metadata_document_supported"):
        row = OutboundMcpOAuthClient(
            issuer=discovery.issuer, resource=discovery.resource, redirect_uri=redirect_uri,
            registration_type="metadata_url",
            client_id=settings.outbound_mcp_client_metadata_url, metadata_json=saved_metadata,
        )
    elif metadata.get("registration_endpoint"):
        registered = _post_json(str(metadata["registration_endpoint"]), _client_metadata(),
                                "OAuth dynamic client registration")
        client_id = registered.get("client_id")
        if not client_id:
            raise OAuthFlowError("The OAuth registration response did not include a client_id.")
        row = OutboundMcpOAuthClient(
            issuer=discovery.issuer, resource=discovery.resource, redirect_uri=redirect_uri,
            registration_type="dynamic",
            client_id=str(client_id), client_secret_encrypted=encrypt(registered.get("client_secret")),
            registration_token_encrypted=encrypt(registered.get("registration_access_token")),
            metadata_json={**saved_metadata, "registration": {
                key: value for key, value in registered.items() if key not in {"client_secret", "registration_access_token"}
            }},
        )
    else:
        raise OAuthFlowError(
            "This OAuth server requires a pre-registered client. Configure a provider client or a client metadata URL."
        )
    db.add(row)
    db.flush()
    return row


def prepare_authorization(db: Session, connection: OutboundMcpConnection,
                          challenge_headers: dict[str, str] | None = None) -> OAuthDiscovery:
    discovery = discover_authorization(connection.server_url, challenge_headers)
    connection.provider = discovery.provider
    connection.canonical_resource = discovery.resource
    connection.authorization_issuer = discovery.issuer
    connection.oauth_metadata_checked_at = datetime.now(UTC)
    connection.auth_status = "authorization_required"
    connection.status = "error"
    connection.last_error = "Authorization is required to discover and use this server's tools."
    resolve_oauth_client(db, discovery)
    db.commit()
    return discovery


def probe_authorization(db: Session, connection: OutboundMcpConnection) -> bool:
    """Probe standard metadata after an anonymous tools/list succeeds.

    A missing metadata document means the server is public. A discovered OAuth server whose client configuration is
    incomplete is an actionable setup error and is deliberately allowed to propagate.
    """
    connection.oauth_metadata_checked_at = datetime.now(UTC)
    try:
        discovery = discover_authorization(connection.server_url, metadata_timeout=4)
    except OAuthMetadataNotFound:
        db.commit()
        return False
    connection.provider = discovery.provider
    connection.canonical_resource = discovery.resource
    connection.authorization_issuer = discovery.issuer
    connection.auth_status = "authorization_required"
    connection.status = "error"
    connection.last_error = "Authorization is required before these tools can access your account."
    resolve_oauth_client(db, discovery)
    db.commit()
    return True


def _saved_discovery(db: Session, connection: OutboundMcpConnection) -> tuple[OAuthDiscovery, OutboundMcpOAuthClient] | None:
    if not connection.authorization_issuer or not connection.canonical_resource:
        return None
    client = db.scalar(select(OutboundMcpOAuthClient).where(
        OutboundMcpOAuthClient.issuer == connection.authorization_issuer,
        OutboundMcpOAuthClient.resource == connection.canonical_resource,
        OutboundMcpOAuthClient.redirect_uri == settings.outbound_mcp_oauth_callback_url,
    ))
    if not client:
        return None
    saved = client.metadata_json or {}
    authorization = saved.get("authorization_server") or saved
    resource = saved.get("protected_resource") or {"resource": connection.canonical_resource}
    discovery = OAuthDiscovery(
        connection.canonical_resource, connection.authorization_issuer, resource, authorization, connection.provider
    )
    return discovery, client


def _scopes(discovery: OAuthDiscovery, client: OutboundMcpOAuthClient,
            requested: list[str] | None = None) -> list[str]:
    supported = discovery.resource_metadata.get("scopes_supported") or []
    supported = [str(scope) for scope in supported] if isinstance(supported, list) else []
    if requested:
        return list(dict.fromkeys(scope for scope in requested if not supported or scope in supported))
    profile_scopes = (client.metadata_json or {}).get("profile", {}).get("default_scopes") or []
    if isinstance(profile_scopes, list) and profile_scopes:
        return list(dict.fromkeys(str(scope) for scope in profile_scopes if not supported or scope in supported))
    if discovery.provider == "google":
        defaults = GOOGLE_WORKSPACE_RESOURCES.get(discovery.resource) or supported
        return [scope for scope in defaults if not supported or scope in supported]
    return supported


def start_authorization(db: Session, connection: OutboundMcpConnection, scopes: list[str] | None = None) -> str:
    if not settings.outbound_mcp_oauth_enabled:
        raise OAuthFlowError("OAuth connections are disabled.")
    saved = _saved_discovery(db, connection)
    if saved:
        discovery, client = saved
    else:
        discovery = discover_authorization(connection.server_url)
        client = resolve_oauth_client(db, discovery)
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(32)
    selected_scopes = _scopes(discovery, client, scopes)
    redirect_uri = settings.outbound_mcp_oauth_callback_url
    attempt = OutboundMcpAuthAttempt(
        connection_id=connection.id, workspace_id=connection.workspace_id, user_id=connection.user_id,
        oauth_client_id=client.id, state_hash=hashlib.sha256(state.encode()).hexdigest(),
        pkce_verifier_encrypted=encrypt(verifier), issuer=discovery.issuer, resource=discovery.resource,
        scopes=selected_scopes, redirect_uri=redirect_uri, expires_at=datetime.now(UTC) + ATTEMPT_TTL,
    )
    db.add(attempt)
    connection.provider = discovery.provider
    connection.canonical_resource = discovery.resource
    connection.authorization_issuer = discovery.issuer
    connection.auth_status = "authorization_required"
    connection.status = "error"
    connection.last_error = "Authorization is required to discover and use this server's tools."
    db.commit()

    metadata = discovery.authorization_metadata
    endpoint = metadata.get("authorization_endpoint")
    if not endpoint:
        raise OAuthFlowError("The OAuth server did not advertise an authorization endpoint.")
    _check_oauth_url(str(endpoint))
    params = {
        "response_type": "code", "client_id": client.client_id, "redirect_uri": redirect_uri,
        "state": state, "code_challenge": challenge, "code_challenge_method": "S256",
        "resource": discovery.resource,
    }
    if selected_scopes:
        params["scope"] = " ".join(selected_scopes)
    if discovery.provider == "google":
        params.update({"access_type": "offline", "prompt": "consent"})
    profile_params = (client.metadata_json or {}).get("profile", {}).get("authorization_params") or {}
    if isinstance(profile_params, dict):
        protected = {"response_type", "client_id", "redirect_uri", "state", "code_challenge",
                     "code_challenge_method", "resource", "scope"}
        params.update({str(key): str(value) for key, value in profile_params.items() if key not in protected})
    return f"{endpoint}?{urlencode(params)}"


def _token_request(client: OutboundMcpOAuthClient, metadata: dict, data: dict[str, str]) -> dict:
    metadata = metadata.get("authorization_server") or metadata
    endpoint = metadata.get("token_endpoint")
    if not endpoint:
        raise OAuthFlowError("The OAuth server did not advertise a token endpoint.")
    data = {**data, "client_id": client.client_id}
    secret = decrypt(client.client_secret_encrypted)
    if secret:
        data["client_secret"] = secret
    return _post_form(str(endpoint), data, "OAuth token exchange")


def _token_expiry(tokens: dict) -> datetime | None:
    try:
        return datetime.now(UTC) + timedelta(seconds=max(0, int(tokens["expires_in"])))
    except (KeyError, TypeError, ValueError):
        return None


def finish_authorization(db: Session, state: str, code: str) -> OutboundMcpConnection:
    state_hash = hashlib.sha256(state.encode()).hexdigest()
    attempt = db.scalar(select(OutboundMcpAuthAttempt).where(
        OutboundMcpAuthAttempt.state_hash == state_hash
    ).with_for_update())
    if not attempt or attempt.used_at or _aware(attempt.expires_at) <= datetime.now(UTC):
        raise OAuthFlowError("This authorization request is invalid or expired.")
    connection = db.get(OutboundMcpConnection, attempt.connection_id)
    client = db.get(OutboundMcpOAuthClient, attempt.oauth_client_id)
    verifier = decrypt(attempt.pkce_verifier_encrypted)
    if not connection or connection.deleted_at is not None or not client or not verifier:
        raise OAuthFlowError("This authorization request can no longer be completed.")
    tokens = _token_request(client, client.metadata_json or {}, {
        "grant_type": "authorization_code", "code": code, "redirect_uri": attempt.redirect_uri,
        "code_verifier": verifier, "resource": attempt.resource,
    })
    access_token = tokens.get("access_token")
    if not access_token:
        raise OAuthFlowError("The OAuth token response did not include an access token.")
    scope_text = tokens.get("scope")
    scopes = str(scope_text).split() if scope_text else list(attempt.scopes or [])
    grant = db.scalar(select(OutboundMcpGrant).where(
        OutboundMcpGrant.connection_id == connection.id
    ).with_for_update())
    if not grant:
        grant = OutboundMcpGrant(
            connection_id=connection.id, workspace_id=connection.workspace_id, user_id=connection.user_id,
            oauth_client_id=client.id, issuer=attempt.issuer, resource=attempt.resource,
            access_token_encrypted=encrypt(str(access_token)), scopes=scopes,
        )
        db.add(grant)
    grant.oauth_client_id = client.id
    grant.issuer, grant.resource = attempt.issuer, attempt.resource
    grant.access_token_encrypted = encrypt(str(access_token))
    if tokens.get("refresh_token"):
        grant.refresh_token_encrypted = encrypt(str(tokens["refresh_token"]))
    grant.token_type = str(tokens.get("token_type") or "Bearer")
    grant.expires_at = _token_expiry(tokens)
    grant.scopes = scopes
    grant.status, grant.revoked_at = "active", None
    attempt.used_at = datetime.now(UTC)
    connection.auth_type = "oauth"
    connection.access_token_encrypted = None
    connection.auth_status = "ready"
    connection.granted_scopes = scopes
    connection.status, connection.last_error = "ready", None
    db.flush()
    return connection


def _mark_reconnect(db: Session, connection: OutboundMcpConnection, grant: OutboundMcpGrant | None,
                    message: str) -> None:
    if grant:
        grant.status = "reconnect_required"
    connection.auth_status = "reconnect_required"
    connection.status = "error"
    connection.last_error = message[:500]
    db.commit()


def access_token_for(connection_id, workspace_id, user_id, *, force_refresh: bool = False) -> str | None:
    """Resolve credentials at call time so refreshes and revocations take effect without rebuilding agent tools."""
    with SessionLocal() as db:
        connection = db.scalar(select(OutboundMcpConnection).where(
            OutboundMcpConnection.id == connection_id,
            OutboundMcpConnection.workspace_id == workspace_id,
            OutboundMcpConnection.user_id == user_id,
            OutboundMcpConnection.deleted_at.is_(None),
        ))
        if not connection:
            raise OAuthFlowError("The MCP connection no longer exists.")
        if connection.auth_type == "none":
            return None
        if connection.auth_type == "bearer":
            token = decrypt(connection.access_token_encrypted)
            if not token:
                raise OAuthFlowError("This connection needs to be reconnected.")
            return token
        grant = db.scalar(select(OutboundMcpGrant).where(
            OutboundMcpGrant.connection_id == connection.id
        ).with_for_update())
        if not grant or grant.status != "active":
            raise OAuthFlowError("This connection needs to be reconnected.")
        token = decrypt(grant.access_token_encrypted)
        expires_soon = grant.expires_at and _aware(grant.expires_at) <= datetime.now(UTC) + REFRESH_EARLY
        if token and not force_refresh and not expires_soon:
            return token
        refresh_token = decrypt(grant.refresh_token_encrypted)
        client = db.get(OutboundMcpOAuthClient, grant.oauth_client_id)
        if not refresh_token or not client:
            _mark_reconnect(db, connection, grant, "Authorization expired. Reconnect this MCP server.")
            raise OAuthFlowError("Authorization expired. Reconnect this MCP server.")
        try:
            tokens = _token_request(client, client.metadata_json or {}, {
                "grant_type": "refresh_token", "refresh_token": refresh_token, "resource": grant.resource,
            })
        except OAuthFlowError as exc:
            if exc.code in {"invalid_grant", "invalid_token"} or exc.status_code == 401:
                _mark_reconnect(db, connection, grant, str(exc))
            raise
        next_token = tokens.get("access_token")
        if not next_token:
            _mark_reconnect(db, connection, grant, "The OAuth refresh response had no access token.")
            raise OAuthFlowError("The OAuth refresh response had no access token.")
        grant.access_token_encrypted = encrypt(str(next_token))
        if tokens.get("refresh_token"):
            grant.refresh_token_encrypted = encrypt(str(tokens["refresh_token"]))
        if tokens.get("scope"):
            grant.scopes = str(tokens["scope"]).split()
            connection.granted_scopes = grant.scopes
        grant.token_type = str(tokens.get("token_type") or grant.token_type or "Bearer")
        grant.expires_at = _token_expiry(tokens)
        grant.refreshed_at = datetime.now(UTC)
        connection.auth_status = "ready"
        connection.status, connection.last_error = "ready", None
        db.commit()
        return str(next_token)


def mark_unauthorized(connection_id, workspace_id, user_id) -> None:
    with SessionLocal() as db:
        connection = db.scalar(select(OutboundMcpConnection).where(
            OutboundMcpConnection.id == connection_id,
            OutboundMcpConnection.workspace_id == workspace_id,
            OutboundMcpConnection.user_id == user_id,
            OutboundMcpConnection.deleted_at.is_(None),
        ))
        if not connection:
            return
        grant = db.scalar(select(OutboundMcpGrant).where(OutboundMcpGrant.connection_id == connection.id))
        _mark_reconnect(db, connection, grant, "Authorization was rejected. Reconnect this MCP server.")


def revoke_connection(db: Session, connection: OutboundMcpConnection) -> None:
    grant = db.scalar(select(OutboundMcpGrant).where(OutboundMcpGrant.connection_id == connection.id))
    if grant:
        client = db.get(OutboundMcpOAuthClient, grant.oauth_client_id)
        saved = client.metadata_json or {} if client else {}
        metadata = saved.get("authorization_server") or saved
        endpoint = metadata.get("revocation_endpoint") if client else None
        token = decrypt(grant.refresh_token_encrypted) or decrypt(grant.access_token_encrypted)
        if endpoint and token and client:
            data = {"token": token, "client_id": client.client_id}
            secret = decrypt(client.client_secret_encrypted)
            if secret:
                data["client_secret"] = secret
            try:
                _check_oauth_url(str(endpoint))
                httpx.post(str(endpoint), data=data, follow_redirects=False,
                           timeout=settings.outbound_mcp_connect_timeout_seconds)
            except httpx.HTTPError:
                pass
        db.delete(grant)
    connection.access_token_encrypted = None
    connection.auth_type = "none"
    connection.auth_status = "authorization_required"
    connection.account_label = None
    connection.granted_scopes = []
    connection.enabled_tools = []
    connection.status = "error"
    connection.last_error = "Authorization disconnected."
    db.commit()
