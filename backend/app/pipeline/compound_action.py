"""Deliver a finished Studio artifact to a capability-matched connected app.

The request has already returned before this worker runs. It waits for the real
NoteStack artifact, renders its exact structured content, invokes the selected
destination adapter, and updates the original assistant message with the result.
"""

import json
import logging
import time
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.mcp_client.tools import invoke_connection_tool_with_widgets, load_external_tools
from app.models import Artifact, Job, Message, OutboundMcpConnection
from app.services.jobs import update_job

log = logging.getLogger("notestack.tool_flow")


def _tool(tools: list, remote_name: str):
    suffix = "_" + remote_name.replace("-", "_")
    return next((item for item in tools
                 if str(getattr(item, "name", getattr(item, "__name__", ""))).endswith(suffix)), None)


def _flashcards_markdown(content: dict) -> tuple[str, int]:
    cards = [card for card in content.get("cards") or [] if isinstance(card, dict)]
    parts = [f"# {content.get('title') or 'Flashcards'}", ""]
    for index, card in enumerate(cards, start=1):
        parts.extend([
            f"## Card {index}",
            f"**Front:** {str(card.get('front') or '')}",
            "",
            f"**Back:** {str(card.get('back') or '')}",
            "",
        ])
    return "\n".join(parts).strip(), len(cards)


def _answer(question: dict) -> str:
    options = question.get("options") or []
    correct = question.get("correct") or []
    if options and correct:
        answers = [str(options[index]) for index in correct if isinstance(index, int) and 0 <= index < len(options)]
        if answers:
            return ", ".join(answers)
    answer = question.get("answer")
    if answer:
        return str(answer)
    accepted = question.get("accepted") or []
    return ", ".join(str(item) for item in accepted)


def _quiz_markdown(content: dict) -> tuple[str, int]:
    questions = [item for item in content.get("questions") or [] if isinstance(item, dict)]
    parts = [f"# {content.get('title') or 'Quiz'}", ""]
    letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    for index, question in enumerate(questions, start=1):
        parts.extend([f"## {index}. {str(question.get('question') or '')}", ""])
        for option_index, option in enumerate(question.get("options") or []):
            label = letters[option_index] if option_index < len(letters) else str(option_index + 1)
            parts.append(f"- {label}. {str(option)}")
        if question.get("options"):
            parts.append("")
        parts.append(f"**Answer:** {_answer(question)}")
        if question.get("explanation"):
            parts.append(f"**Explanation:** {str(question['explanation'])}")
        parts.append("")
    return "\n".join(parts).strip(), len(questions)


def _generic_markdown(value: Any, level: int = 1) -> list[str]:
    """Losslessly turn other structured artifacts into readable Markdown."""
    if isinstance(value, dict):
        lines: list[str] = []
        for key, child in value.items():
            if key == "title" and level == 1:
                continue
            label = str(key).replace("_", " ").strip().title()
            if isinstance(child, dict | list):
                lines.extend([f"{'#' * min(level + 1, 6)} {label}", ""])
                lines.extend(_generic_markdown(child, level + 1))
            elif child not in (None, ""):
                lines.extend([f"**{label}:** {child}", ""])
        return lines
    if isinstance(value, list):
        lines = []
        for index, child in enumerate(value, start=1):
            if isinstance(child, dict | list):
                lines.extend([f"{'#' * min(level + 1, 6)} Item {index}", ""])
                lines.extend(_generic_markdown(child, level + 1))
            else:
                lines.append(f"- {child}")
        lines.append("")
        return lines
    return [str(value), ""]


def _render(artifact: Artifact) -> tuple[str, int]:
    content = artifact.content_json or {}
    if artifact.type == "flashcards":
        return _flashcards_markdown(content)
    if artifact.type == "quiz":
        return _quiz_markdown(content)
    body = _generic_markdown(content)
    markdown = "\n".join([f"# {content.get('title') or artifact.type.replace('_', ' ').title()}", "", *body]).strip()
    meaningful = [value for key, value in content.items() if key != "title" and value not in (None, "", [], {})]
    return markdown, len(meaningful)


def _connection(db: Session, job: Job, params: dict) -> OutboundMcpConnection | None:
    raw = params.get("connection_id")
    if not raw:
        return None  # legacy Notion jobs loaded all enabled tools
    try:
        connection_id = uuid.UUID(str(raw))
    except ValueError:
        return None
    return db.scalar(select(OutboundMcpConnection).where(
        OutboundMcpConnection.id == connection_id,
        OutboundMcpConnection.workspace_id == job.workspace_id,
        OutboundMcpConnection.deleted_at.is_(None),
        OutboundMcpConnection.enabled.is_(True),
        OutboundMcpConnection.status == "ready",
    ))


def _call(db: Session, job: Job, params: dict, tool_name: str, arguments: dict,
          *, capture_urls: bool = False) -> tuple[str, list[str], list[dict]]:
    connection = _connection(db, job, params)
    if connection is None:
        raise RuntimeError("The selected connected app is no longer available.")
    return invoke_connection_tool_with_widgets(
        job.workspace_id,
        uuid.UUID(str(params["user_id"])),
        connection,
        tool_name,
        arguments,
        capture_resource_urls=capture_urls,
    )


def _call_parts(result: tuple) -> tuple[str, list[str], list[dict]]:
    """Accept older two-item test adapters while production also carries MCP Apps."""
    raw = str(result[0])
    urls = list(result[1] or [])
    widgets = list(result[2] or []) if len(result) > 2 else []
    return raw, urls, widgets


def _replace_page(db: Session, job: Job, params: dict, page_url: str, markdown: str) -> None:
    if params.get("connection_id"):
        _call(db, job, params, "notion-update-page", {
            "page_id": page_url,
            "command": "replace_content",
            "new_str": markdown,
            "allow_async": False,
        })
        return
    # Compatibility for jobs queued by the earlier Notion-only implementation.
    bundle = load_external_tools(
        job.workspace_id,
        uuid.UUID(str(params["user_id"])),
        db,
        notebook_id=uuid.UUID(str(params["notebook_id"])),
    )
    update = _tool(bundle.tools, "notion-update-page")
    if update is None:
        raise RuntimeError("The enabled connection does not provide update-page.")
    update(page_id=page_url, command="replace_content", new_str=markdown, allow_async=False)


def _json_payload(text: str) -> dict:
    """Find the structured payload in an MCP result that may also contain text blocks."""
    candidates: list[Any] = []
    try:
        candidates.append(json.loads(text))
    except (json.JSONDecodeError, TypeError):
        decoder = json.JSONDecoder()
        for index, char in enumerate(text):
            if char != "{":
                continue
            try:
                value, _ = decoder.raw_decode(text[index:])
                candidates.append(value)
                break
            except json.JSONDecodeError:
                continue

    def find(value: Any) -> dict | None:
        if isinstance(value, dict):
            if any(key in value for key in ("status", "job_id", "design", "edit_url", "url")):
                return value
            for child in value.values():
                found = find(child)
                if found:
                    return found
        elif isinstance(value, list):
            for child in value:
                found = find(child)
                if found:
                    return found
        return None

    for candidate in candidates:
        if found := find(candidate):
            return found
    raise RuntimeError("The connected app returned no readable job status.")


def _result_urls(payload: Any) -> list[str]:
    preferred = ("edit_url", "url", "view_url", "web_url", "browser_url")
    found: list[str] = []

    def visit(value: Any) -> None:
        if isinstance(value, dict):
            for key in preferred:
                child = value.get(key)
                if isinstance(child, str) and child.startswith("https://") and child not in found:
                    found.append(child)
            for child in value.values():
                if isinstance(child, dict | list):
                    visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(payload)
    return found


def _canva_widget(db: Session, job: Job, params: dict, state: dict) -> list[dict]:
    """Render the completed poll result with Canva's create-design MCP App."""
    connection = _connection(db, job, params)
    if connection is None:
        return []
    create_tool = next(
        (tool for tool in (connection.discovered_tools or []) if tool.get("name") == "create-design"),
        None,
    )
    resource_uri = (create_tool or {}).get("ui_resource_uri")
    payload = state.get("payload")
    if not isinstance(resource_uri, str) or not resource_uri or not isinstance(payload, dict):
        return []
    return [{
        "connection_id": str(connection.id),
        "connection": connection.name,
        "tool": "create-design",
        "arguments": dict(state.get("create_arguments") or {}),
        "resource_uri": resource_uri,
        # create-design owns the UI template, while the polling tool owns the completed payload. The MCP App receives
        # them together only after completion, so writers never see Canva's broken pending-state card.
        "result": {
            "content": [{"type": "text", "text": json.dumps(payload)}],
            "structuredContent": payload,
            "isError": False,
        },
    }]


def _canva_design(db: Session, job: Job, params: dict, markdown: str) -> tuple[str, list[str], list[dict]]:
    state = dict(params.get("delivery_state") or {})
    if not state.get("job_id"):
        title = str(params.get("title") or "NoteStack artifact")
        request = str(params.get("question") or "")
        brief = (
            f"Create a polished design titled {json.dumps(title)}. Follow the writer's original design requirements "
            f"exactly, including requested colors, layout, and format. Original request: {request}\n\n"
            "Use the following finalized NoteStack artifact content exactly. Preserve every question, answer, and "
            f"important detail; do not invent replacements.\n\n{markdown}"
        )
        create_arguments = {
            "brief": brief,
            "user_intent": request or f"Create a design for {title}",
        }
        raw, captured, returned_widgets = _call_parts(_call(
            db, job, params, "create-design", create_arguments, capture_urls=True,
        ))
        payload = _json_payload(raw)
        state = {
            "status": payload.get("status"),
            "job_id": payload.get("job_id"),
            "continuation_token": payload.get("continuation_token"),
            "payload": payload,
            # Prefer destination-specific edit URLs over the generic resource URL collector's view URL.
            "urls": list(dict.fromkeys([*_result_urls(payload), *captured])),
            "widgets": returned_widgets,
            "create_arguments": create_arguments,
        }
        job.params = {**params, "delivery_state": state}
        db.commit()  # retrying the worker must poll the existing design, never create a duplicate

    deadline = time.monotonic() + 300
    while str(state.get("status") or "pending").lower() in {"pending", "running", "in_progress", "queued"}:
        if not state.get("job_id"):
            raise RuntimeError("The design job did not include a job id.")
        if time.monotonic() >= deadline:
            raise RuntimeError("The design did not finish in time.")
        policy = (state.get("payload") or {}).get("polling_policy") or {}
        wait_seconds = max(0.0, min(float(policy.get("wait_seconds") or 2), 10.0))
        update_job(db, job, progress=0.75, message="Waiting for the connected app to finish the design")
        time.sleep(wait_seconds)
        arguments = {
            "job_id": state["job_id"],
            "user_intent": str(params.get("question") or "Check the design creation job"),
        }
        if state.get("continuation_token"):
            arguments["continuation_token"] = state["continuation_token"]
        raw, captured, returned_widgets = _call_parts(_call(
            db, job, params, "get-create-design-async-job", arguments, capture_urls=True,
        ))
        payload = _json_payload(raw)
        state.update({
            "status": payload.get("status") or state.get("status"),
            "continuation_token": payload.get("continuation_token") or state.get("continuation_token"),
            "payload": payload,
            "urls": list(dict.fromkeys([*_result_urls(payload), *(state.get("urls") or []), *captured])),
            "widgets": returned_widgets or list(state.get("widgets") or []),
        })
        params = {**params, "delivery_state": state}
        job.params = params
        db.commit()

    status = str(state.get("status") or "").lower()
    if status not in {"completed", "complete", "done", "succeeded", "success"}:
        payload = state.get("payload") or {}
        raise RuntimeError(str(payload.get("error") or payload.get("message") or "The design could not be created."))
    urls = list(state.get("urls") or [])
    if not urls:
        raise RuntimeError("The design finished but returned no link.")
    returned_widgets = list(state.get("widgets") or [])
    return urls[0], urls, returned_widgets or _canva_widget(db, job, params, state)


def _update_message(db: Session, params: dict, text: str, state: str, detail: str,
                    destination_url: str | None = None, external_widgets: list[dict] | None = None) -> None:
    raw = params.get("message_id")
    if not raw:
        return
    message = db.get(Message, uuid.UUID(str(raw)))
    if message is None:
        return
    recall = dict(message.recall_json or {})
    sources = list(recall.get("external_sources") or [])
    if destination_url:
        source = {
            "connection": str(params.get("destination_name") or "connected app"),
            "tool": str(params.get("adapter") or "artifact delivery"),
            "urls": [destination_url],
        }
        sources = [item for item in sources if item.get("connection") != source["connection"]]
        sources.append(source)
    message.content = text
    message.recall_json = {
        **recall,
        "external_sources": sources,
        **({"external_widgets": external_widgets} if external_widgets is not None else {}),
        "background_status": {
            "state": state,
            "message": detail,
            **({"url": destination_url} if destination_url else {}),
        },
    }
    db.commit()


def _failure(db: Session, params: dict, reason: str, *, page_url: str | None = None) -> tuple[dict, str]:
    artifact_type = str(params.get("artifact_type") or "artifact").replace("_", " ")
    artifact_url = params.get("artifact_url")
    destination = str(params.get("destination_name") or "the connected app")
    links = []
    if artifact_url:
        links.append(f"- [Open the NoteStack {artifact_type}]({artifact_url})")
    if page_url:
        links.append(f"- [Open the {destination} destination]({page_url})")
    text = f"The {artifact_type} could not be delivered to {destination}: {reason}"
    if links:
        text += "\n\n" + "\n".join(links)
    _update_message(db, params, text, "failed", reason, page_url)
    return {
        "status": "failed",
        "artifact_id": params.get("artifact_id"),
        **({"destination_url": page_url} if page_url else {}),
        "error": reason,
    }, "Artifact delivery failed"


def complete(db: Session, job: Job) -> tuple[dict, str]:
    """Wait off-request for the artifact, deliver it, then update the saved answer."""
    params = dict(job.params or {})
    artifact = db.get(Artifact, uuid.UUID(str(params["artifact_id"])))
    if not artifact or artifact.workspace_id != job.workspace_id:
        return _failure(db, params, "The NoteStack artifact no longer exists.")

    page_url = str(params["destination_url"]) if params.get("destination_url") else None
    log.info("compound_action job=%s artifact=%s: waiting for artifact", job.id, artifact.id)
    deadline = time.monotonic() + 300
    while artifact.status not in {"ready", "failed"} and time.monotonic() < deadline:
        update_job(db, job, progress=0.1, message="Waiting for the NoteStack artifact")
        time.sleep(2)
        artifact_id = artifact.id
        db.expire_all()
        artifact = db.get(Artifact, artifact_id)
        if artifact is None:
            return _failure(db, params, "The NoteStack artifact was removed.", page_url=page_url)

    if artifact.status != "ready":
        reason = ((artifact.content_json or {}).get("error") if artifact.status == "failed"
                  else "The artifact did not finish in time.")
        if page_url:
            try:
                _replace_page(db, job, params, page_url, f"# Artifact generation failed\n\n{reason}")
            except Exception:
                log.exception("compound_action job=%s could not put the failure on the destination page", job.id)
        return _failure(db, params, str(reason), page_url=page_url)

    markdown, item_count = _render(artifact)
    if not item_count:
        reason = "The artifact finished without any transferable content."
        if page_url:
            _replace_page(db, job, params, page_url, f"# No content was generated\n\n{reason}")
        return _failure(db, params, reason, page_url=page_url)

    if not page_url and params.get("artifact_url"):
        artifact_type = artifact.type.replace("_", " ")
        destination = str(params.get("destination_name") or "the connected app")
        _update_message(
            db,
            params,
            f"The NoteStack {artifact_type} is ready. I’m creating the {destination} destination now.\n\n"
            f"- [Open the NoteStack {artifact_type}]({params['artifact_url']})",
            "working",
            f"Creating the {destination} destination",
        )

    try:
        update_job(db, job, progress=0.6, message="Sending the finished artifact to the connected app")
        adapter = params.get("adapter") or "notion_page"  # compatibility for older queued jobs
        if adapter == "notion_page":
            if not page_url:
                raise RuntimeError("The destination page link is missing.")
            _replace_page(db, job, params, page_url, markdown)
            destination_url = page_url
            urls = [page_url]
        elif adapter == "async_design":
            destination_url, urls, external_widgets = _canva_design(db, job, params, markdown)
        else:
            raise RuntimeError(f"No delivery adapter is available for {adapter!r}.")
    except Exception as exc:
        log.exception("compound_action job=%s could not deliver artifact=%s", job.id, artifact.id)
        return _failure(db, params, " ".join(str(exc).split())[:500] or type(exc).__name__, page_url=page_url)

    artifact_type = artifact.type.replace("_", " ")
    destination = str(params.get("destination_name") or "the connected app")
    artifact_url = params.get("artifact_url")
    links = []
    if artifact_url:
        links.append(f"- [Open the NoteStack {artifact_type}]({artifact_url})")
    links.append(f"- [Open in {destination}]({destination_url})")
    text = f"The {artifact_type} is ready and has been added to {destination}.\n\n" + "\n".join(links)
    if adapter != "async_design":
        external_widgets = []
    _update_message(
        db, params, text, "done", "Artifact delivered", destination_url,
        external_widgets=external_widgets,
    )
    log.info("compound_action job=%s artifact=%s delivered via %s", job.id, artifact.id, params.get("adapter"))
    return {
        "status": "done",
        "artifact_id": str(artifact.id),
        "artifact_type": artifact.type,
        "destination_url": destination_url,
        "destination_urls": urls,
        "external_widgets": external_widgets,
        "item_count": item_count,
    }, "Artifact delivered to connected app"
