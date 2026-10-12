"""remove_block: a removed visual's offer to add it again comes back, so the reader is never stuck with no way in.
copy_block: reusing an artifact the user already made points the new block at it, never raising for one that is ready."""

import uuid

import pytest

from app.models import Artifact
from app.pipeline.generate import NothingToDo
from app.pipeline.report import copy_block, remove_block


def _content(blocks, suggestions=None):
    return {"blocks": blocks, "suggestions": suggestions or []}


def test_removing_a_visual_restores_its_add_offer():
    content = _content([
        {"id": "b1", "type": "prose", "text": "intro"},
        {"id": "b2", "type": "quiz", "after": "b1", "title": "Quiz"},
        {"id": "b3", "type": "prose", "text": "more"},
    ])
    out = remove_block(content, "b2")
    assert out is not None
    assert [b["id"] for b in out["blocks"]] == ["b1", "b3"]
    assert [s["kind"] for s in out["suggestions"]] == ["quiz"]
    assert out["suggestions"][0]["after_block_id"] == "b1"


def test_removing_leaves_an_existing_suggestion_of_the_same_kind_alone():
    existing = {"id": "s1", "after_block_id": "b1", "kind": "quiz", "brief": "custom", "why": "custom"}
    content = _content(
        [{"id": "b1", "type": "prose", "text": "intro"}, {"id": "b2", "type": "quiz", "after": "b1", "title": "Quiz"}],
        [existing],
    )
    out = remove_block(content, "b2")
    assert out["suggestions"] == [existing]  # not duplicated


def test_prose_cannot_be_removed():
    content = _content([{"id": "b1", "type": "prose", "text": "intro"}])
    assert remove_block(content, "b1") is None


def test_unknown_block_id_returns_none():
    content = _content([{"id": "b1", "type": "prose", "text": "intro"}])
    assert remove_block(content, "nope") is None


def test_a_kind_with_no_fallback_brief_is_removed_without_a_restored_suggestion():
    content = _content([
        {"id": "b1", "type": "prose", "text": "intro"},
        {"id": "b2", "type": "table", "after": "b1"},
    ])
    out = remove_block(content, "b2")
    assert out["blocks"] == [{"id": "b1", "type": "prose", "text": "intro"}]
    assert out["suggestions"] == []


def _artifact(content_json: dict, storage_key: str | None = None) -> Artifact:
    a = Artifact(id=uuid.uuid4(), workspace_id=uuid.uuid4(), type="x", status="ready", content_json=content_json)
    a.storage_key = storage_key
    return a


def test_copy_block_reuses_a_ready_infographic_by_its_content_not_a_storage_key():
    # Infographics render from stored HTML (content_json["content"]), never from storage_key: that field is always
    # None for them. Checking storage_key here used to make every reuse fail with "nothing to add".
    existing = _artifact({"title": "My infographic", "theme": "midnight", "content": {"title": "t"}}, storage_key=None)
    block = copy_block("infographic", existing)
    assert block == {"title": "My infographic", "artifact_id": str(existing.id), "theme": "midnight"}


def test_copy_block_rejects_an_infographic_with_no_content():
    existing = _artifact({"title": "Empty"}, storage_key=None)
    with pytest.raises(NothingToDo):
        copy_block("infographic", existing)


def test_copy_block_reuses_mind_map_quiz_and_flashcards():
    assert copy_block("mind_map", _artifact({"title": "Map", "root": {"id": "root"}, "node_count": 3, "post_count": 2})) == \
        {"title": "Map", "root": {"id": "root"}, "node_count": 3, "post_count": 2}
    assert copy_block("quiz", _artifact({"title": "Q", "questions": [{"question": "?"}]})) == \
        {"title": "Q", "questions": [{"question": "?"}]}
    assert copy_block("flashcards", _artifact({"title": "C", "cards": [{"front": "f", "back": "b"}]})) == \
        {"title": "C", "cards": [{"front": "f", "back": "b"}]}


def test_copy_block_rejects_a_kind_with_nothing_to_reuse():
    with pytest.raises(NothingToDo):
        copy_block("quiz", _artifact({"title": "Q", "questions": []}))
