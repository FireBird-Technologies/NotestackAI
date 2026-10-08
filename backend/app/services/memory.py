"""The writer's standing notes ("audience: indie founders"), one JSON row per workspace.

Every chat loads them as background for tone and focus. They are never evidence: only posts are, and
citations still get checked. Notes come from the writer (Settings) or from the memory job, which reads
the writer's own messages and decides what is worth keeping. Notes the writer typed are never changed
by the job."""

import re
import uuid
from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import WorkspaceMemory

MAX_FACTS = 20
MAX_KEY = 60
MAX_VALUE = 500
PROFILE_CHARS = 1500


def normalize_key(key: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", key.strip().lower()).strip("-")[:MAX_KEY]


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _row(db: Session, workspace_id: uuid.UUID, *, lock: bool = False, create: bool = False) -> WorkspaceMemory | None:
    """The workspace's row. lock=True holds it (FOR UPDATE on Postgres) so two writers cannot overwrite each other."""
    q = select(WorkspaceMemory).where(WorkspaceMemory.workspace_id == workspace_id)
    row = db.scalar(q.with_for_update() if lock else q)
    if row or not create:
        return row
    db.add(WorkspaceMemory(workspace_id=workspace_id, facts={}))
    try:
        db.flush()
    except IntegrityError:  # another request created it first
        db.rollback()
    return db.scalar(q.with_for_update() if lock else q)


def _item(key: str, fact: dict) -> dict:
    return {"key": key, "value": fact.get("value", ""), "source": fact.get("source", "user"),
            "updated_at": fact.get("updated_at")}


def list_facts(db: Session, workspace_id: uuid.UUID) -> list[dict]:
    row = _row(db, workspace_id)
    items = [_item(k, f) for k, f in (row.facts or {}).items()] if row else []
    return sorted(items, key=lambda i: i["updated_at"] or "", reverse=True)


def set_fact(db: Session, workspace_id: uuid.UUID, key: str, value: str, source: str = "user") -> dict:
    """Create or replace one note (the writer typing in Settings). Raises 422 on bad input."""
    key, value = normalize_key(key), value.strip()
    if not key:
        raise HTTPException(422, "Give the note a short name")
    if not value:
        raise HTTPException(422, "The note cannot be empty")
    if len(value) > MAX_VALUE:
        raise HTTPException(422, f"Keep each note under {MAX_VALUE} characters")
    row = _row(db, workspace_id, lock=True, create=True)
    facts = dict(row.facts or {})
    if key not in facts and len(facts) >= MAX_FACTS:
        raise HTTPException(422, f"You can keep up to {MAX_FACTS} notes. Delete one to add another.")
    facts[key] = {"value": value, "source": source, "updated_at": _now()}
    row.facts = facts  # a new dict, so the JSON column is saved
    db.commit()
    return _item(key, facts[key])


def delete_fact(db: Session, workspace_id: uuid.UUID, key: str) -> bool:
    row = _row(db, workspace_id, lock=True)
    key = normalize_key(key)
    if not row or key not in (row.facts or {}):
        return False
    row.facts = {k: v for k, v in row.facts.items() if k != key}
    db.commit()
    return True


def apply_operations(db: Session, workspace_id: uuid.UUID, ops: list[dict]) -> list[dict]:
    """Apply the memory job's add/update/delete decisions. Bad or unsafe ones are skipped, never raised:
    notes the writer typed stay as they are, the cap holds, and repeats change nothing. Returns what changed."""
    row = _row(db, workspace_id, lock=True, create=True)
    facts = dict(row.facts or {})
    applied: list[dict] = []
    for op in ops:
        kind, key = op.get("op"), normalize_key(str(op.get("key") or ""))
        value = str(op.get("value") or "").strip()
        current = facts.get(key)
        if not key or (current and current.get("source") == "user"):
            continue
        if kind in ("add", "update"):
            if not value or len(value) > MAX_VALUE or (current and current.get("value") == value):
                continue
            if current is None and len(facts) >= MAX_FACTS:
                continue
            facts[key] = {"value": value, "source": "auto", "updated_at": _now()}
            applied.append({"op": "update" if current else "add", "key": key, "value": value})
        elif kind == "delete" and current:
            del facts[key]
            applied.append({"op": "delete", "key": key})
    if applied:
        row.facts = facts
    db.commit()
    return applied


def profile_text(items: list[dict]) -> str:
    """Prompt block for the agents: one line per note, capped so the prompt stays small."""
    if not items:
        return "(none)"
    return "\n".join(f"- {i['key']}: {i['value']}" for i in items)[:PROFILE_CHARS]
