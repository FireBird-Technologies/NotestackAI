# ruff: noqa: F811, E501
"""The MCP tools beyond find/ask: reading, organising, generating, sharing. Run as a signed-in writer through the real API."""

import json
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException
from mcp.server.auth.provider import AccessToken

from app.mcp import common, limits, scope, tools_write, views, widgets
from app.models import Artifact, DocumentTopic, Job, Notebook, Topic, User, Workspace
from tests.test_buildout import auth, connect, docs, feed  # noqa: F401  (fixtures and helpers)
from tests.test_mcp import _blog, anyio_backend, as_writer, call, call_raw, fake_research, mcp, mcp_db  # noqa: F401  (fixtures and helpers)
from tests.test_videos import API, b2v, make_video  # noqa: F401  (fixture and helper)


def writer_with(monkeypatch, client, auth, db_session, scopes):  # noqa: F811
    me = client.get("/api/auth/me", headers=auth).json()
    tv = db_session.get(User, uuid.UUID(me["id"])).token_version
    access = AccessToken(token="x", client_id="t", scopes=scopes, subject=me["id"], claims={"tv": tv, "gid": str(uuid.uuid4())})
    monkeypatch.setattr(common, "get_access_token", lambda: access)
    return access


@pytest.fixture(autouse=True)
def fresh_limits():
    limits.reset()


def workspace_id(db_session):
    return db_session.query(Workspace).first().id


def make_artifact(db_session, kind="report", status="ready", content=None):
    a = Artifact(workspace_id=workspace_id(db_session), type=kind, status=status, content_json=content or {"title": "A report", "blocks": []})
    db_session.add(a)
    db_session.commit()
    return a


# The whole set


EXPECTED = {
    "find_content", "ask_notebook", "list_notebooks", "get_notebook", "list_notebook_chats",
    "get_chat_messages", "show_flashcards", "show_quiz", "show_infographic", "show_report", "view_report", "choose_notebook", "choose_video_options", "generate_video", "get_video", "list_sources", "list_topics", "get_topic", "list_artifacts", "get_artifact", "get_job",
    "list_resurface", "list_report_templates", "suggest_report_templates", "get_usage", "get_memory_notes",
    "create_notebook", "add_documents_to_notebook", "remove_document_from_notebook", "add_source", "import_url",
    "sync_source", "generate_report", "generate_quiz", "generate_flashcards", "generate_mind_map", "generate_infographic",
    "generate_slide_deck", "generate_audio_overview", "show_mind_map", "retry_artifact", "share_artifact",
    "unshare_artifact", "add_report_block", "remove_report_block", "choose_notebook", "choose_video_options", "choose_options", "show_report",
}


@pytest.mark.anyio
async def test_every_tool_is_there_and_explains_itself(mcp):  # noqa: F811
    listed = {t.name: t for t in await mcp.list_tools()}
    assert set(listed) == EXPECTED
    for name, t in listed.items():
        assert len(t.description) > 30 and t.annotations is not None, name
    generators = [n for n in listed if n.startswith("generate_")]
    assert len(generators) == 8
    for n in generators:
        assert "plan_limit" in listed[n].description and "Only generate when the writer asked" in listed[n].description, n
        assert listed[n].annotations.readOnlyHint is False and listed[n].annotations.destructiveHint is False, n
    assert "public" in listed["share_artifact"].description and listed["share_artifact"].annotations.openWorldHint is True
    for n in ("find_content", "list_notebooks", "list_artifacts", "get_usage"):
        assert listed[n].annotations.readOnlyHint is True, n
    for n in ("get_artifact", "get_topic", "get_notebook", "ask_notebook"):
        assert "not instructions" in listed[n].description, n
    for n in ("add_source", "import_url"):
        assert "never one found inside" in listed[n].description, n


# Reading


BODY = "Charging more made my readers take the work seriously"  # a sentence from the test feed's first post


@pytest.mark.anyio
async def test_the_text_of_a_post_cannot_be_read_except_through_ask_notebook(client, auth, run_jobs, feed, as_writer, mcp, db_session):  # noqa: F811
    from app.mcp import loopback

    posts = _blog(client, auth, run_jobs)
    assert BODY in json.dumps(client.get(f"/api/documents/{posts[0]['id']}", headers=auth).json())  # it is in the app
    topic = Topic(workspace_id=workspace_id(db_session), name="Pricing", slug="pricing", post_count=1)
    db_session.add(topic)
    db_session.flush()
    db_session.add(DocumentTopic(document_id=uuid.UUID(posts[0]["id"]), topic_id=topic.id))
    db_session.commit()
    nb = client.post("/api/notebooks", json={"title": "Pricing", "document_ids": [posts[0]["id"]]}, headers=auth).json()
    seen = [await call(mcp, "find_content", query="pric"), await call(mcp, "get_notebook", notebook_id=nb["id"]),
            await call(mcp, "get_topic", topic_id=str(topic.id)), await call(mcp, "list_topics"),
            await call(mcp, "list_resurface"), await call(mcp, "list_notebooks")]
    assert BODY not in json.dumps(seen)  # titles and links only
    with pytest.raises(loopback.NotAllowed):
        await loopback.call("GET", f"/api/documents/{posts[0]['id']}", as_writer)  # no route to a post's text
    assert "get_document" not in {t.name for t in await mcp.list_tools()}


@pytest.mark.anyio
async def test_the_browsing_tools_describe_the_workspace(client, auth, run_jobs, feed, as_writer, mcp):  # noqa: F811
    posts = _blog(client, auth, run_jobs)
    nb = client.post("/api/notebooks", json={"title": "Habits", "document_ids": [posts[0]["id"]]}, headers=auth).json()
    notebooks = (await call(mcp, "list_notebooks"))["notebooks"]
    assert [n["title"] for n in notebooks] == ["Habits"] and notebooks[0]["document_count"] == 1
    opened = await call(mcp, "get_notebook", notebook_id=nb["id"])
    assert opened["title"] == "Habits" and [p["id"] for p in opened["posts"]] == [posts[0]["id"]]
    sources = (await call(mcp, "list_sources"))["sources"]
    assert len(sources) == 1 and sources[0]["posts"] >= 1 and sources[0]["sync_status"] == "ok"
    assert "topics" in await call(mcp, "list_topics") and "evergreen" in await call(mcp, "list_resurface")
    assert "notes" in await call(mcp, "get_memory_notes") and await call(mcp, "get_usage")
    assert (await call(mcp, "list_notebook_chats", notebook_id=nb["id"]))["chats"] == []
    templates = await call(mcp, "list_report_templates")
    assert templates["templates"] and set(templates["interactive"]) == {"id", "name", "description"}
    assert all("prompt" not in t for t in templates["templates"])


@pytest.mark.anyio
async def test_the_settings_form_offers_the_apps_real_choices(client, auth, run_jobs, feed, as_writer, mcp):  # noqa: F811
    _blog(client, auth, run_jobs)
    first = (await mcp.call_tool("choose_options", {"make": "quiz"})).structuredContent  # nothing chosen: the form starts with what to use
    assert first["notebook_id"] is None and "notebooks" in first and first["posts"] and first["tool"] == "generate_quiz"
    assert first["notebooks"][0]["title"] == "All posts"
    assert client.get("/api/notebooks", headers=auth).json() == []  # opening the form does not persist it
    quiz = await call(mcp, "choose_options", make="quiz")
    assert [f["argument"] for f in quiz["fields"]] == ["count", "difficulty", "question_types", "topic"]
    assert quiz["fields"][1]["choices"] == ["Easy", "Medium", "Hard"]
    report = await mcp.call_tool("choose_options", {"make": "report"})
    form = report.structuredContent
    assert form["kind"] == "generation_options" and form["tool"] == "generate_report" and form["notebook_id"] is None
    assert form["notebooks"] and form["posts"]
    template = next(f for f in form["fields"] if f["key"] == "template_id")
    assert len(template["options"]) > 1 and template["options"][0]["value"] == ""
    assert all("img" not in option for option in template["options"])
    for kind in ("flashcards", "infographic", "slide_deck", "audio_overview", "mind_map", "video"):
        choice = (await mcp.call_tool("choose_options", {"make": kind})).structuredContent
        assert choice["fields"] and choice["notebook_id"] is None and choice["notebooks"]


@pytest.mark.anyio
async def test_the_settings_form_includes_every_notebook_in_activity_order(as_writer, mcp, db_session):  # noqa: F811
    base = datetime(2026, 1, 1, tzinfo=UTC)
    notebooks = [Notebook(workspace_id=workspace_id(db_session), title=f"Notebook {i:02d}",
                          updated_at=base + timedelta(minutes=i)) for i in range(45)]
    db_session.add_all(notebooks)
    db_session.commit()

    result = await call_raw(mcp, "choose_options", make="mind_map")
    shown = result.structuredContent["notebooks"]
    assert len(shown) == 46  # every stored notebook, plus the unpersisted All posts choice
    assert [n["title"] for n in shown] == ["All posts"] + [f"Notebook {i:02d}" for i in reversed(range(45))]


@pytest.mark.anyio
async def test_the_options_tool_does_not_allow_a_model_to_skip_source_selection(mcp):  # noqa: F811
    tool = next(t for t in await mcp.list_tools() if t.name == "choose_options")
    assert set(tool.inputSchema["properties"]) == {"make"}
    assert "always shown" in tool.description


@pytest.mark.anyio
async def test_topics_are_listed_and_opened(client, auth, run_jobs, feed, as_writer, mcp, db_session):  # noqa: F811
    posts = _blog(client, auth, run_jobs)
    topic = Topic(workspace_id=workspace_id(db_session), name="Pricing", slug="pricing", summary="What I charge", post_count=1)
    db_session.add(topic)
    db_session.flush()
    db_session.add(DocumentTopic(document_id=uuid.UUID(posts[0]["id"]), topic_id=topic.id))
    db_session.commit()
    listed = (await call(mcp, "list_topics"))["topics"]
    assert [t["name"] for t in listed] == ["Pricing"]
    opened = await call(mcp, "get_topic", topic_id=str(topic.id))
    assert opened["name"] == "Pricing" and [p["id"] for p in opened["posts"]] == [posts[0]["id"]]


@pytest.mark.anyio
async def test_artifacts_are_listed_light_and_opened_trimmed(client, auth, as_writer, mcp, db_session):  # noqa: F811
    quiz = make_artifact(db_session, "quiz", content={"title": "Quiz", "questions": [{"q": "why?"}]})
    huge = make_artifact(db_session, "report", content={"title": "Big", "text": "x" * 200_000})
    listed = await call(mcp, "list_artifacts", type="quiz")
    assert listed["total"] == 1 and "content" not in listed["items"][0] and listed["items"][0]["id"] == str(quiz.id)
    opened = await call(mcp, "get_artifact", artifact_id=str(quiz.id))
    assert opened["content"]["questions"] == [{"q": "why?"}] and opened["open_in_notestack"].endswith("/app/archive")
    big = await call(mcp, "get_artifact", artifact_id=str(huge.id))
    assert "content" not in big and len(big["content_preview"]) < 20_000 and "Open it in Notestack" in big["content_truncated"]
    assert big["open_in_notestack"].endswith(f"/app/reports/{huge.id}")


def test_inline_html_never_reaches_the_assistant():
    art = {"id": "1", "type": "infographic", "status": "ready", "content": {"title": "T", "html": "<div>" * 5000,
           "html_landscape": "<p>", "slides_html": ["<s>"], "slide_slots": [1], "points": ["a"]}, "job": None}
    view = views.artifact_view(art)
    assert "content" not in view and "<div>" not in json.dumps(view)  # a visual: links and a note, not its data
    assert "do not redraw" in view["show_it"].lower() or "Do not redraw" in view["show_it"]
    text = views.artifact_view({**art, "type": "quiz", "content": {"title": "T", "html": "<p>", "questions": ["q"]}})
    assert text["content"] == {"title": "T", "questions": ["q"]} and "show_it" not in text


# Organising


@pytest.mark.anyio
async def test_notebooks_can_be_made_filled_and_emptied(client, auth, run_jobs, feed, as_writer, mcp):  # noqa: F811
    posts = _blog(client, auth, run_jobs)
    made = await call(mcp, "create_notebook", title="Launch", document_ids=[posts[0]["id"]])
    assert made["posts_added"] == 1
    assert (await call(mcp, "add_documents_to_notebook", notebook_id=made["id"], document_ids=[p["id"] for p in posts]))["added"] == len(posts) - 1
    assert len((await call(mcp, "get_notebook", notebook_id=made["id"]))["posts"]) == len(posts)
    await call(mcp, "remove_document_from_notebook", notebook_id=made["id"], document_id=posts[0]["id"])
    assert len((await call(mcp, "get_notebook", notebook_id=made["id"]))["posts"]) == len(posts) - 1
    assert len(client.get("/api/documents", headers=auth).json()["items"]) == len(posts)  # the post itself is untouched


@pytest.mark.anyio
async def test_a_source_is_added_and_followed_to_the_end(client, auth, run_jobs, feed, as_writer, mcp):  # noqa: F811
    added = await call(mcp, "add_source", url="ada.example.com")
    assert added["source_id"] and added["job"]["id"]
    assert (await call(mcp, "get_job", job_id=added["job"]["id"]))["status"] == "queued"
    run_jobs()
    assert (await call(mcp, "get_job", job_id=added["job"]["id"]))["status"] == "done"
    again = await call(mcp, "sync_source", source_id=added["source_id"])
    assert again["job"]["id"] != added["job"]["id"]


@pytest.mark.anyio
async def test_a_private_address_is_never_fetched(client, auth, run_jobs, as_writer, mcp, monkeypatch):  # noqa: F811
    import httpx

    requested = []

    def spy(url, *a, **k):
        requested.append(url)
        raise httpx.ConnectError("no network in tests")

    monkeypatch.setattr(httpx, "get", spy)
    urls = ("http://169.254.169.254/latest/meta-data/", "http://localhost:5432/", "http://10.0.0.5/feed")
    for url in urls:
        await call(mcp, "add_source", url=url)  # refused at once, or queued and failed when it runs
        imported = await call(mcp, "import_url", url=url)
        if "job" in imported:
            run_jobs()
            assert (await call(mcp, "get_job", job_id=imported["job"]["id"]))["status"] == "failed", url
    assert not any(any(h in r for h in ("169.254", "localhost", "10.0.0.5")) for r in requested), requested
    assert client.get("/api/documents", headers=auth).json()["items"] == []


async def ask(mcp, client, auth, question, **kw):
    """ask_notebook in the writer's chosen notebook (the all-posts one unless told otherwise)."""
    kw.setdefault("notebook_id", client.post("/api/notebooks/archive", headers=auth).json()["id"])
    return await call(mcp, "ask_notebook", question=question, **kw)


# Choosing what to use


@pytest.mark.anyio
async def test_a_source_uses_all_posts_with_a_filter_without_a_scratch_notebook(client, auth, run_jobs, feed, as_writer, mcp):  # noqa: F811
    posts = _blog(client, auth, run_jobs)
    source_id = client.get("/api/sources", headers=auth).json()[0]["id"]
    first = await call(mcp, "generate_quiz", source_id=source_id)
    assert first["status"] == "pending" and first["type"] == "quiz" and first["job"]["status"] == "queued"
    assert f"Used {len(posts)} posts" in first["scope_note"]
    second = await call(mcp, "generate_flashcards", source_id=source_id)
    assert f"Used {len(posts)} posts" in second["scope_note"]
    notebooks = client.get("/api/notebooks", headers=auth).json()
    assert [(n["title"], n["artifact_count"]) for n in notebooks] == [("All posts", 2)]


@pytest.mark.anyio
async def test_a_topic_filters_all_posts_without_a_scratch_notebook(client, auth, run_jobs, feed, as_writer, mcp, db_session):  # noqa: F811
    posts = _blog(client, auth, run_jobs)
    topic = Topic(workspace_id=workspace_id(db_session), name="Pricing", slug="pricing", post_count=1)
    db_session.add(topic)
    db_session.flush()
    db_session.add(DocumentTopic(document_id=uuid.UUID(posts[0]["id"]), topic_id=topic.id))
    db_session.commit()
    out = await call(mcp, "generate_mind_map", topic_id=str(topic.id), focus="pricing", wait_seconds=0)
    assert out["type"] == "mind_map" and "Used 1 posts from topic 'Pricing'" in out["scope_note"]
    assert [n["title"] for n in client.get("/api/notebooks", headers=auth).json()] == ["All posts"]


@pytest.mark.anyio
async def test_loose_posts_use_a_filter_without_a_scratch_notebook(client, auth, run_jobs, feed, as_writer, mcp):  # noqa: F811
    posts = _blog(client, auth, run_jobs)
    ids = [p["id"] for p in posts]
    a = await call(mcp, "generate_infographic", document_ids=ids)
    b = await call(mcp, "generate_infographic", document_ids=list(reversed(ids)))
    assert "chosen posts" in a["scope_note"] and "chosen posts" in b["scope_note"]
    assert [n["title"] for n in client.get("/api/notebooks", headers=auth).json()] == ["All posts"]


@pytest.mark.anyio
async def test_selected_posts_stay_in_the_existing_notebook(client, auth, run_jobs, feed, as_writer, mcp):  # noqa: F811
    posts = _blog(client, auth, run_jobs)
    nb = client.post("/api/notebooks", json={"title": "Research", "document_ids": [p["id"] for p in posts]}, headers=auth).json()
    out = await call(mcp, "generate_quiz", notebook_id=nb["id"], document_ids=[posts[0]["id"]])
    assert out["notebook_id"] == nb["id"] and "'Research'" in out["scope_note"]
    assert [n["title"] for n in client.get("/api/notebooks", headers=auth).json()] == ["Research"]


@pytest.mark.anyio
async def test_all_posts_use_the_archive_notebook(client, auth, run_jobs, feed, as_writer, mcp):  # noqa: F811
    _blog(client, auth, run_jobs)
    out = await call(mcp, "generate_slide_deck", archive=True, deck_length="short")
    assert out["type"] == "slide_deck" and out["notebook_id"] and out["scope_note"] == "Used all their posts."


@pytest.mark.anyio
async def test_at_most_one_choice_can_be_made(as_writer, mcp):
    for args in ({"archive": True, "notebook_id": str(uuid.uuid4())}, {"topic_id": str(uuid.uuid4()), "source_id": str(uuid.uuid4())}):
        assert (await call(mcp, "generate_quiz", **args))["error"] == "pick_one"


@pytest.mark.anyio
async def test_with_nothing_named_the_writer_is_asked_to_choose(client, auth, run_jobs, feed, as_writer, mcp, fake_research):  # noqa: F811
    posts = _blog(client, auth, run_jobs)
    made = await call(mcp, "create_notebook", title="Research", document_ids=[posts[0]["id"]])
    assert made["title"] == "Claude Research"  # always starts with Claude
    for name in ("generate_quiz", "generate_flashcards", "generate_report", "generate_video", "ask_notebook"):
        args = {"question": "hi"} if name == "ask_notebook" else {}
        out = await call(mcp, name, **args)
        assert out["error"] == "choose_scope" and ("choose_options" in out["message"] or "choose_notebook" in out["message"]), name
        assert any(n["notebook_id"] == made["id"] for n in out["notebooks"])
    named = await call(mcp, "generate_quiz", notebook_id=made["id"])
    assert named["notebook_id"] == made["id"] and "'Claude Research'" in named["scope_note"]  # a named one is used, and said


@pytest.mark.anyio
async def test_importing_asks_where_the_posts_go_then_fills_the_chosen_notebook(client, auth, run_jobs, feed, as_writer, mcp):  # noqa: F811
    added = await call(mcp, "add_source", url="ada.example.com")
    assert "list_notebooks" in added["ask_writer"] and "new" in added["ask_writer"]
    run_jobs()
    made = await call(mcp, "create_notebook", title="Claude Ada", source_id=added["source_id"])
    assert made["posts_added"] >= 1
    other = await call(mcp, "create_notebook", title="Claude Other", document_ids=[(await call(mcp, "get_notebook", notebook_id=made["id"]))["posts"][0]["id"]])
    more = await call(mcp, "add_documents_to_notebook", notebook_id=other["id"], source_id=added["source_id"])
    assert more["added"] == made["posts_added"] - 1
    assert (await call(mcp, "create_notebook", title="Claude Empty"))["error"] == "nothing_to_use"


@pytest.mark.anyio
async def test_an_empty_choice_says_so(client, auth, run_jobs, feed, as_writer, mcp, db_session):  # noqa: F811
    _blog(client, auth, run_jobs)
    topic = Topic(workspace_id=workspace_id(db_session), name="Empty", slug="empty", post_count=0)
    db_session.add(topic)
    db_session.commit()
    assert (await call(mcp, "generate_quiz", topic_id=str(topic.id)))["error"] == "nothing_to_use"
    assert (await call(mcp, "generate_quiz", source_id=str(uuid.uuid4())))["error"] == "not_found"


@pytest.mark.anyio
async def test_generating_from_a_topic_needs_permission_to_edit(client, auth, run_jobs, feed, monkeypatch, mcp, db_session):  # noqa: F811
    posts = _blog(client, auth, run_jobs)
    writer_with(monkeypatch, client, auth, db_session, ["mcp:read"])
    out = await call(mcp, "generate_quiz", document_ids=[posts[0]["id"]])
    assert out["error"] == "not_allowed"
    assert [n for n in client.get("/api/notebooks", headers=auth).json() if n["title"].startswith("Claude: ")] == []


# Generating


@pytest.mark.anyio
async def test_a_plan_limit_is_explained_not_hidden(client, auth, run_jobs, feed, as_writer, mcp, monkeypatch):  # noqa: F811
    from app.routers import artifacts

    _blog(client, auth, run_jobs)

    def over(*a, **k):
        raise HTTPException(402, {"code": "plan_limit", "message": "You have used your reports.", "kind": "reports",
                                  "plan": "free", "upgrade_to": "writer"})

    monkeypatch.setattr(artifacts, "check_limit", over)
    out = await call(mcp, "generate_report", archive=True)
    assert out["error"] == "plan_limit" and out["upgrade_to"] == "writer" and out["kind"] == "reports"


@pytest.mark.anyio
async def test_social_artifact_generators_are_not_exposed_and_cannot_be_retried(as_writer, mcp, db_session):
    listed = {t.name for t in await mcp.list_tools()}
    assert "generate_launch_kit" not in listed
    assert not any("carousel" in name or "quote_card" in name for name in listed)
    launch_kit = make_artifact(db_session, "launch_kit", status="failed", content={"title": "Social kit"})
    out = await call(mcp, "retry_artifact", artifact_id=str(launch_kit.id))
    assert out["error"] == "unsupported_artifact"


@pytest.mark.anyio
async def test_audio_options_are_checked_by_the_app(client, auth, run_jobs, feed, as_writer, mcp):  # noqa: F811
    _blog(client, auth, run_jobs)
    out = await call(mcp, "generate_audio_overview", archive=True, format="debate", hosts=1)
    assert out["error"] == "request_failed" and "two hosts" in out["message"]
    ok = await call(mcp, "generate_audio_overview", archive=True, format="brief", minutes=99)
    assert ok["type"] == "audio_overview" and ok["status"] == "pending"


@pytest.mark.anyio
async def test_waiting_stops_when_the_result_is_ready(monkeypatch):
    seen = []

    async def data(method, path, access, **kw):
        seen.append(path)
        return {"id": "a1", "status": "ready" if len(seen) >= 2 else "generating"}

    async def nap(_):
        return None

    monkeypatch.setattr(tools_write.loopback, "data", data)
    monkeypatch.setattr(tools_write.asyncio, "sleep", nap)
    out = await tools_write._wait(None, {"id": "a1", "status": "pending"}, 50)
    assert out["status"] == "ready" and len(seen) == 2
    seen.clear()
    assert (await tools_write._wait(None, {"id": "a1", "status": "pending"}, 0))["status"] == "pending" and seen == []


@pytest.mark.anyio
async def test_a_failed_generation_can_be_retried(client, auth, run_jobs, feed, as_writer, mcp, db_session):  # noqa: F811
    _blog(client, auth, run_jobs)
    made = await call(mcp, "generate_report", archive=True, wait_seconds=0)
    assert (await call(mcp, "retry_artifact", artifact_id=made["id"]))["error"] == "request_failed"  # still queued
    art = db_session.get(Artifact, uuid.UUID(made["id"]))
    art.status = "failed"
    db_session.query(Job).filter(Job.artifact_id == art.id).update({"status": "failed"})
    db_session.commit()
    again = await call(mcp, "retry_artifact", artifact_id=made["id"])
    assert again["status"] == "pending" and again["job"]["status"] == "queued"


# Sharing


@pytest.mark.anyio
async def test_sharing_needs_its_own_permission(client, auth, monkeypatch, mcp, db_session):  # noqa: F811
    report = make_artifact(db_session)
    writer_with(monkeypatch, client, auth, db_session, ["mcp:read", "mcp:write"])
    assert (await call(mcp, "share_artifact", artifact_id=str(report.id)))["error"] == "not_allowed"
    assert client.get(f"/api/artifacts/{report.id}/share", headers=auth).json()["shared"] is False


@pytest.mark.anyio
async def test_a_report_is_shared_then_unshared(client, auth, monkeypatch, mcp, db_session):  # noqa: F811
    report = make_artifact(db_session)
    writer_with(monkeypatch, client, auth, db_session, ["mcp:read", "mcp:write", "mcp:share"])
    shared = await call(mcp, "share_artifact", artifact_id=str(report.id))
    assert shared["shared"] is True and shared["url"].startswith("http") and "/r/" in shared["url"]
    token = shared["url"].rsplit("/", 1)[-1]
    assert client.get(f"/api/public/reports/{token}").status_code == 200
    assert (await call(mcp, "unshare_artifact", artifact_id=str(report.id)))["shared"] is False
    assert client.get(f"/api/public/reports/{token}").status_code == 404


@pytest.mark.anyio
async def test_sharing_respects_the_workspaces_privacy_setting(client, auth, monkeypatch, mcp, db_session):  # noqa: F811
    report = make_artifact(db_session)
    client.patch("/api/settings", json={"allow_public_links": False}, headers=auth)
    writer_with(monkeypatch, client, auth, db_session, ["mcp:read", "mcp:write", "mcp:share"])
    out = await call(mcp, "share_artifact", artifact_id=str(report.id))
    assert out["error"] == "not_allowed" and "turned off" in out["message"]


@pytest.mark.anyio
async def test_only_finished_reports_can_be_shared(client, auth, monkeypatch, mcp, db_session):  # noqa: F811
    pending = make_artifact(db_session, status="pending")
    writer_with(monkeypatch, client, auth, db_session, ["mcp:read", "mcp:write", "mcp:share"])
    assert (await call(mcp, "share_artifact", artifact_id=str(pending.id)))["error"] == "not_found"


# Report visuals


@pytest.mark.anyio
async def test_a_visual_is_added_to_a_report_and_bad_ids_are_refused(client, auth, as_writer, mcp, db_session):  # noqa: F811
    report = make_artifact(db_session, content={"title": "R", "blocks": [{"id": "b1", "type": "section"}],
                                                "source": {"document_ids": [str(uuid.uuid4())]}})
    out = await call(mcp, "add_report_block", artifact_id=str(report.id), kind="quiz", brief="test them", suggestion_id="s1")
    assert out["id"] == str(report.id) and out["job"]["kind"] == "report_block"
    assert (await call(mcp, "add_report_block", artifact_id=str(report.id), kind="quiz", after_block_id="nope"))["error"] == "not_found"
    for bad in ("../x", "a b", "", "x" * 41):
        assert (await call(mcp, "remove_report_block", artifact_id=str(report.id), block_id=bad))["error"] == "bad_id"
    assert (await call(mcp, "remove_report_block", artifact_id=str(report.id), block_id="gone"))["error"] == "not_found"


# The guard around every tool


@pytest.mark.anyio
async def test_a_runaway_app_is_slowed_down(as_writer, mcp, monkeypatch):
    monkeypatch.setattr(limits, "PER_MINUTE", 5)
    answers = [await call(mcp, "get_usage") for _ in range(6)]
    assert answers[-1]["error"] == "rate_limited" and all("error" not in a for a in answers[:5])


@pytest.mark.anyio
async def test_each_connection_has_its_own_allowance(client, auth, monkeypatch, mcp, db_session):  # noqa: F811
    monkeypatch.setattr(limits, "PER_MINUTE", 2)
    writer_with(monkeypatch, client, auth, db_session, ["mcp:read"])
    assert [("error" in await call(mcp, "get_usage")) for _ in range(3)] == [False, False, True]
    writer_with(monkeypatch, client, auth, db_session, ["mcp:read"])  # another grant
    assert "error" not in await call(mcp, "get_usage")


@pytest.mark.anyio
async def test_tool_calls_are_logged_without_their_content(client, auth, as_writer, mcp, caplog):  # noqa: F811
    import logging

    with caplog.at_level(logging.INFO, logger="notestack.mcp"):
        await call(mcp, "find_content", query="a very private question about my divorce")
    line = next(r.getMessage() for r in caplog.records if r.name == "notestack.mcp")
    assert "tool=find_content" in line and "outcome=" in line and "ms=" in line and "divorce" not in line


def test_the_choice_helper_is_exported_for_other_tools():
    assert scope.MAX_POSTS == 300 and json.dumps(common.GEN)


# One conversation, one chat


def chats_of(client, auth, notebook_id):
    return client.get(f"/api/notebooks/{notebook_id}/chats", headers=auth).json()


@pytest.mark.anyio
async def test_a_conversation_stays_in_one_chat_titled_for_the_app(client, auth, run_jobs, feed, as_writer, mcp, fake_research):
    _blog(client, auth, run_jobs)
    first = await ask(mcp, client, auth, "What about pricing?")
    assert first["continued_chat"] is False and "chat_id" in first["note"]
    # the assistant forgets to pass chat_id: the next question still joins the same chat
    second = await ask(mcp, client, auth, "And habits?")
    third = await ask(mcp, client, auth, "Compare them", chat_id=first["chat_id"])
    assert second["chat_id"] == first["chat_id"] == third["chat_id"] and second["continued_chat"] and third["continued_chat"]
    chats = chats_of(client, auth, first["notebook_id"])
    assert len(chats) == 1 and chats[0]["title"] == "Claude: What about pricing?"
    msgs = client.get(f"/api/notebooks/chats/{first['chat_id']}/messages", headers=auth).json()
    assert [m["role"] for m in msgs] == ["user", "assistant"] * 3


@pytest.mark.anyio
async def test_a_question_long_after_starts_a_new_chat(client, auth, run_jobs, feed, as_writer, mcp, fake_research, db_session):
    from datetime import UTC, datetime, timedelta

    from app.models import Chat

    _blog(client, auth, run_jobs)
    first = await ask(mcp, client, auth, "Morning question")
    db_session.query(Chat).update({"updated_at": datetime.now(UTC) - timedelta(hours=2)})
    db_session.commit()
    later = await ask(mcp, client, auth, "Evening question")
    assert later["chat_id"] != first["chat_id"] and later["continued_chat"] is False
    assert sorted(c["title"] for c in chats_of(client, auth, first["notebook_id"])) == ["Claude: Evening question", "Claude: Morning question"]


@pytest.mark.anyio
async def test_the_writers_own_chats_are_never_continued(client, auth, run_jobs, feed, as_writer, mcp, fake_research):
    _blog(client, auth, run_jobs)
    archive = {"id": client.post("/api/notebooks/archive", headers=auth).json()["id"]}
    own = client.post(f"/api/notebooks/{archive['id']}/chat", json={"question": "My own question"}, headers=auth).text
    assert "event: answer" in own
    out = await ask(mcp, client, auth, "From the assistant")
    assert out["continued_chat"] is False
    assert sorted(c["title"] for c in chats_of(client, auth, archive["id"])) == ["Claude: From the assistant", "My own question"]


@pytest.mark.anyio
async def test_each_app_keeps_its_own_chat(client, auth, run_jobs, feed, monkeypatch, mcp, fake_research, db_session):
    posts = _blog(client, auth, run_jobs)
    me = client.get("/api/auth/me", headers=auth).json()
    tv = db_session.get(User, uuid.UUID(me["id"])).token_version

    def as_app(name):
        access = AccessToken(token="x", client_id="c", scopes=["mcp:read", "mcp:write"], subject=me["id"],
                             claims={"tv": tv, "gid": "g-" + name, "cn": name})
        monkeypatch.setattr(common, "get_access_token", lambda: access)

    as_app("Claude")
    a = await ask(mcp, client, auth, "Question one")
    as_app("ChatGPT")
    b = await ask(mcp, client, auth, "Question two")
    chatgpt_nb = await call(mcp, "create_notebook", title="Research", document_ids=[posts[0]["id"]])
    as_app("Claude")
    c = await ask(mcp, client, auth, "Question three")
    claude_nb = await call(mcp, "create_notebook", title="Research", document_ids=[posts[0]["id"]])
    assert a["chat_id"] == c["chat_id"] != b["chat_id"]
    assert sorted(x["title"] for x in chats_of(client, auth, a["notebook_id"])) == ["ChatGPT: Question two", "Claude: Question one"]
    assert chatgpt_nb["title"] == "ChatGPT Research" and claude_nb["title"] == "Claude Research"


def test_the_app_name_is_carried_into_the_tool(db_session):
    import asyncio

    from app.mcp import provider, tokens

    me = User(email="n@example.com", name="N", auth_provider="email")
    db_session.add(me)
    db_session.commit()
    from app.models import McpClient, McpGrant

    db_session.add(McpClient(client_id="cid-1", info={"client_name": "Claude  "}))
    db_session.flush()
    grant = McpGrant(user_id=me.id, client_id="cid-1", scopes=["mcp:read"], refresh_hash="h",
                     refresh_expires_at=datetime_now())
    db_session.add(grant)
    db_session.commit()
    token, _ = tokens.mint_access(me.id, me.token_version, grant.id, "cid-1", ["mcp:read"])
    access = asyncio.run(provider.NotestackProvider().load_access_token(token))
    assert access.claims["cn"] == "Claude"


def datetime_now():
    from datetime import UTC, datetime, timedelta

    return datetime.now(UTC) + timedelta(days=1)


MAP = {"label": "Agentic AI", "note": "The big idea", "quote": "SECRET RAW QUOTE", "children": [
    {"label": "Self-organizing agents", "note": "They coordinate themselves", "quote": "SECRET RAW QUOTE",
     "children": [{"label": "Bitter Lesson", "note": "Learning beats design", "children": []}]},
    {"label": "Control risks", "note": "What can go wrong", "children": []}]}


def test_a_mind_map_comes_as_an_outline_and_a_link_not_raw_data():
    art = {"id": "m1", "type": "mind_map", "type_label": "Mind Constellation", "title": "Map", "status": "ready",
           "notebook_id": "nb1", "content": {"title": "Map", "root": MAP}, "job": None}
    view = views.artifact_view(art)
    assert view["outline"].splitlines() == [
        "- Agentic AI: The big idea", "  - Self-organizing agents: They coordinate themselves",
        "    - Bitter Lesson", "  - Control risks: What can go wrong"]
    assert "SECRET RAW QUOTE" not in json.dumps(view) and "content" not in view and "content_preview" not in view
    assert view["open_in_notestack"].endswith("/app/artifacts/m1") and "redraw" in view["show_it"]  # straight to the map
    assert views.web_url({"id": "q1", "type": "quiz", "notebook_id": "nb1"}).endswith("/app/notebooks/nb1")
    assert "outline" not in views.artifact_view(art, content=False)  # lists stay light


@pytest.mark.anyio
async def test_visual_tools_tell_the_assistant_to_point_at_notestack(mcp):  # noqa: F811
    listed = {t.name: t.description for t in await mcp.list_tools()}
    for name in ("generate_mind_map", "generate_infographic", "generate_slide_deck", "generate_audio_overview"):
        assert "Do not redraw or recreate it yourself" in listed[name], name
    assert "do not redraw it" in listed["get_artifact"]
    for name in ("generate_report", "generate_quiz", "generate_flashcards"):
        assert "redraw" not in listed[name], name  # these are text: the assistant can use them


# The picture in the chat (MCP Apps)


WIDGET = widgets.MIND_MAP_URI
SAMPLE = {"label": "Agentic AI", "note": "n", "id": "SECRET-ID", "children": [
    {"label": f"Branch {i}", "note": "x" * 500, "path": "secret/path.md", "children": [
        {"label": f"Point {i}.{j}", "note": "", "children": [{"label": "deep", "children": [{"label": "deeper", "children": [
            {"label": "too deep", "children": []}]}]}]} for j in range(3)],
     "sources": [{"title": "Post", "quote": "q" * 900, "document_id": "SECRET-DOC", "path": "secret/p.md"}] * 6}
    for i in range(60)]}


def test_the_widget_gets_labels_and_quotes_but_never_ids_paths_or_a_flood():
    from app.mcp import widgets

    out = widgets.mind_map_payload({"status": "ready", "title": "T", "content": {"root": SAMPLE}}, "http://x/open")
    text = json.dumps(out)
    assert "SECRET" not in text and "secret/" not in text and "document_id" not in text and '"path"' not in text
    assert text.count('"label"') <= widgets.MAX_NODES
    assert "too deep" not in text  # the deepest levels are dropped
    first = out["root"]["children"][0]
    assert len(first["note"]) == 300 and len(first["sources"]) == widgets.MAX_SOURCES and len(first["sources"][0]["quote"]) == 300
    assert out["open_url"] == "http://x/open" and out["status"] == "ready"


def test_a_big_map_keeps_every_theme_before_it_drops_fine_detail():
    from app.mcp import widgets

    big = {"label": "Root", "children": [
        {"label": f"Theme {i}", "children": [{"label": f"Point {i}.{j}", "children": [{"label": "detail"} for _ in range(4)]} for j in range(20)]}
        for i in range(6)]}
    out = widgets.mind_map_payload({"status": "ready", "title": "T", "content": {"root": big}}, "http://x/open")
    themes = out["root"]["children"]
    assert len(themes) == 6
    assert all(len(t["children"]) == 20 for t in themes)  # no theme is starved by the ones before it
    assert len(json.dumps(out).split('"label"')) - 1 <= widgets.MAX_NODES


def test_a_map_still_being_made_tells_the_widget_so():
    from app.mcp import widgets

    waiting = widgets.mind_map_payload({"status": "generating", "content": {}}, "u")
    assert waiting["root"] is None and "still being made" in waiting["message"]
    failed = widgets.mind_map_payload({"status": "failed", "content": {}}, "u")
    assert failed["root"] is None and "could not" in failed["message"]


@pytest.mark.anyio
async def test_the_map_tools_link_to_the_widget_and_it_is_served(mcp):  # noqa: F811
    listed = {t.name: t for t in await mcp.list_tools()}
    assert listed["generate_mind_map"].meta == {"ui": {"resourceUri": WIDGET, "visibility": ["app"]}}
    assert listed["show_mind_map"].meta == {"ui": {"resourceUri": WIDGET}}
    cards = {"ui": {"resourceUri": widgets.FLASHCARDS_URI}}
    assert listed["generate_flashcards"].meta == widgets.app_only(cards) and listed["show_flashcards"].meta == cards
    quiz = {"ui": {"resourceUri": widgets.QUIZ_URI}}
    assert listed["generate_quiz"].meta == widgets.app_only(quiz) and listed["show_quiz"].meta == quiz
    infographic = {"ui": {"resourceUri": widgets.INFOGRAPHIC_URI}}
    assert listed["generate_infographic"].meta == widgets.app_only(infographic) and listed["show_infographic"].meta == infographic
    viewers = {"generate_mind_map", "show_mind_map", "generate_flashcards", "show_flashcards", "generate_quiz", "show_quiz",
               "generate_infographic", "show_infographic", "choose_notebook", "choose_options", "choose_video_options",
               "generate_slide_deck", "generate_audio_overview", "generate_video", "get_video", "view_report", "generate_report"}
    assert all(t.meta is None for n, t in listed.items() if n not in viewers)
    assert all(listed[name].meta["ui"]["visibility"] == ["app"] for name in listed if name.startswith("generate_"))
    resources = await mcp.list_resources()
    served = {widgets.MIND_MAP_URI, widgets.FLASHCARDS_URI, widgets.QUIZ_URI, widgets.INFOGRAPHIC_URI, widgets.PICKER_URI, widgets.REPORT_URI,
              widgets.VIDEO_URI, widgets.VIDEO_OPTIONS_URI, widgets.OPTIONS_URI}
    assert {str(r.uri) for r in resources} == served and all(r.mimeType == "text/html;profile=mcp-app" for r in resources)
    page = list(await mcp.read_resource(WIDGET))[0].content
    for needed in ("ui/initialize", "ui/notifications/initialized", "ui/notifications/tool-result", "ui/notifications/size-changed",
                   "ui/open-link", "ui/resource-teardown", "window.parent"):
        assert needed in page, needed


def test_the_widget_page_is_self_contained_and_never_writes_html_from_posts():
    import re
    from pathlib import Path

    page = (Path(__file__).parent.parent / "app" / "mcp" / "widgets" / "mind_map.html").read_text()
    assert not re.search(r"<script[^>]+src=|<link[^>]+href=|@import|url\(\s*['\"]?https?:|fetch\(|XMLHttpRequest|WebSocket", page)
    assert "innerHTML" not in page and "outerHTML" not in page and "document.write" not in page and "eval(" not in page
    assert "e.source !== window.parent" in page  # only the host can talk to it
    assert '<select id="shape"' in page
    assert all(f'value="{shape}"' in page for shape in ("orbit", "spiral", "constellation", "cluster"))
    assert "function changeShape(next)" in page and "window.openai.setWidgetState" in page


@pytest.mark.anyio
async def test_show_mind_map_sends_the_map_to_the_widget_and_words_to_the_model(client, auth, as_writer, mcp, db_session):  # noqa: F811
    art = make_artifact(db_session, "mind_map", content={"title": "Map", "root": SAMPLE})
    result = await call_raw(mcp, "show_mind_map", artifact_id=str(art.id))
    seen_by_model = result.content[0].text
    assert "outline" in seen_by_model and "Branch 1" in seen_by_model
    assert "x" * 200 not in seen_by_model  # notes are cut short in the outline; the full text is the widget's
    assert "SECRET" not in seen_by_model and "q" * 50 not in seen_by_model
    assert result.structuredContent["kind"] == "mind_map" and result.structuredContent["root"]["label"] == "Agentic AI"
    assert result.structuredContent["open_url"].endswith(f"/app/artifacts/{art.id}")
    assert "Do not redraw" in json.loads(seen_by_model)["show_it"]


@pytest.mark.anyio
async def test_show_mind_map_refuses_other_artifacts_and_waits_for_unfinished_ones(client, auth, as_writer, mcp, db_session):  # noqa: F811
    quiz = make_artifact(db_session, "quiz", content={"title": "Q", "questions": []})
    assert (await call(mcp, "show_mind_map", artifact_id=str(quiz.id)))["error"] == "not_a_mind_map"
    unfinished = make_artifact(db_session, "mind_map", status="generating", content={})
    result = await call_raw(mcp, "show_mind_map", artifact_id=str(unfinished.id))
    assert result.structuredContent["root"] is None and "still being made" in result.structuredContent["message"]
    assert (await call(mcp, "show_mind_map", artifact_id="../x"))["error"] == "bad_id"


@pytest.mark.anyio
async def test_generate_mind_map_waits_a_while_by_default_and_gives_the_widget_its_data(client, auth, run_jobs, feed, as_writer, mcp, monkeypatch):  # noqa: F811
    _blog(client, auth, run_jobs)
    waits = []

    async def quick(access, art, seconds):
        waits.append(seconds)
        return {**art, "status": "ready", "content": {"title": "Map", "root": {"label": "Root", "children": []}}}

    monkeypatch.setattr(tools_write, "_wait", quick)
    result = await call_raw(mcp, "generate_mind_map", archive=True)
    assert waits == [40]
    assert result.structuredContent["root"]["label"] == "Root" and json.loads(result.content[0].text)["status"] == "ready"


CARDS = [{"front": "Why?", "back": "Because.", "sources": [{"path": "secret/p.md", "document_id": "SECRET-DOC"}]}] * 70


def test_the_flashcard_widget_gets_fronts_and_backs_only():
    from app.mcp import widgets

    out = widgets.flashcards_payload({"status": "ready", "title": "Cards", "content": {"cards": CARDS}}, "http://x/open")
    assert out["kind"] == "flashcards" and out["open_url"] == "http://x/open"
    assert len(out["cards"]) == widgets.MAX_CARDS and out["cards"][0] == {"front": "Why?", "back": "Because."}
    assert "SECRET" not in json.dumps(out)
    waiting = widgets.flashcards_payload({"status": "generating", "content": {}}, "u")
    assert waiting["cards"] == [] and "still being made" in waiting["message"]


def test_the_flashcard_page_is_self_contained():
    import re
    from pathlib import Path

    page = (Path(__file__).parent.parent / "app" / "mcp" / "widgets" / "flashcards.html").read_text()
    assert not re.search(r"<script[^>]+src=|<link[^>]+href=|@import|url\(\s*['\"]?https?:|fetch\(|XMLHttpRequest|WebSocket", page)
    assert "innerHTML" not in page and "eval(" not in page and "e.source !== window.parent" in page and "ui/open-link" in page


@pytest.mark.anyio
async def test_show_flashcards_sends_the_cards_to_the_widget_with_a_link(client, auth, as_writer, mcp, db_session):  # noqa: F811
    art = make_artifact(db_session, "flashcards", content={"title": "Cards", "cards": CARDS[:3]})
    result = await call_raw(mcp, "show_flashcards", artifact_id=str(art.id))
    assert result.structuredContent["kind"] == "flashcards" and len(result.structuredContent["cards"]) == 3
    seen = json.loads(result.content[0].text)
    assert seen["open_in_notestack"] and seen["card_count"] == 3 and "content" not in seen and "Why?" not in result.content[0].text
    assert "no quiz" in seen["shown_in_chat"]
    quiz = make_artifact(db_session, "quiz", content={"title": "Q", "questions": []})
    assert (await call(mcp, "show_flashcards", artifact_id=str(quiz.id)))["error"] == "not_flashcards"


@pytest.mark.anyio
async def test_a_video_is_made_by_notestack_and_linked(client, auth, run_jobs, feed, as_writer, mcp, monkeypatch):  # noqa: F811
    from app.routers import videos

    _blog(client, auth, run_jobs)
    seen = {}

    def fake(ctx, body):
        seen["ids"] = body.document_ids or [body.document_id]
        raise HTTPException(402, {"code": "plan_limit", "message": "No videos left.", "kind": "videos", "plan": "free", "upgrade_to": "writer"})

    monkeypatch.setattr(videos, "_source", fake)
    monkeypatch.setattr(videos.b2v, "configured", lambda: True)
    nb = client.post("/api/notebooks/archive", headers=auth).json()["id"]
    assert (await call(mcp, "generate_video"))["error"] == "choose_scope"
    out = await call(mcp, "generate_video", notebook_id=nb)
    assert out["error"] == "plan_limit" and seen["ids"]  # the posts came from the chosen notebook
    assert "/app/videos/" in __import__("app.mcp.views", fromlist=["x"]).web_url({"type": "video", "id": "abc"})


@pytest.mark.anyio
async def test_get_video_polls_render_status_and_returns_the_finished_mp4(client, auth, as_writer, mcp, b2v):  # noqa: F811
    art = make_video(client, auth)
    b2v.queue("GET", "/api/v1/videos/812/status", (200, {
        "status": "done", "ready": True, "video_url": "https://cdn.test/video.mp4",
    }))

    result = await call_raw(mcp, "get_video", artifact_id=art["id"])

    assert result.structuredContent["status"] == "ready"
    assert result.structuredContent["video_url"] == "https://cdn.test/video.mp4"
    assert "/api/v1/videos/812/status" in b2v.paths("GET")


@pytest.mark.anyio
async def test_get_video_shows_live_preview_while_rendering_an_mp4(client, auth, as_writer, mcp, b2v):  # noqa: F811
    art = make_video(client, auth)
    generated = (200, {"status": "generated", "ready": True, "video_url": None})
    b2v.queue("GET", "/api/v1/videos/812/status", generated, generated, generated)
    b2v.queue("GET", "/api/projects/812/render-status", (200, {
        "progress": 100, "r2_video_url": "https://cdn.test/final.mp4",
    }))

    result = await call_raw(mcp, "get_video", artifact_id=art["id"])

    assert result.structuredContent["status"] == "rendering"
    assert result.structuredContent["video_url"] is None
    assert result.structuredContent["preview_url"] == f"{API}/embed/t"
    view = json.loads(result.content[0].text)
    assert view["ready"] is False and view["poll_url"] == "http://localhost:8000/api/videos/widget-status"
    assert view["poll_token"] and view["poll_token"] not in view["poll_url"]
    headers = {"Origin": "https://claude.ai", "Content-Type": "text/plain"}
    rendering = client.post("/api/videos/widget-status", content=view["poll_token"], headers=headers)
    assert rendering.status_code == 200 and rendering.json()["status"] == "rendering"
    assert rendering.json()["preview_url"] == f"{API}/embed/t"
    assert "/api/projects/812/render" in b2v.paths("POST")
    direct = client.post("/api/videos/widget-status", content=view["poll_token"], headers=headers)
    assert direct.status_code == 200 and direct.json()["video_url"] == "https://cdn.test/final.mp4"
    assert direct.json()["ready"] is True and direct.headers["access-control-allow-origin"] == "*"
    assert direct.headers["cache-control"] == "no-store"
    assert "/api/projects/812/render-status" in b2v.paths("GET")


@pytest.mark.anyio
async def test_a_finished_report_is_presented_from_notestack_with_its_notebook(client, auth, run_jobs, feed, as_writer, mcp, db_session):  # noqa: F811
    _blog(client, auth, run_jobs)
    nb = client.post("/api/notebooks/archive", headers=auth).json()
    made = await call(mcp, "generate_report", report_format="interactive", instructions="detailed", wait_seconds=0, notebook_id=nb["id"])
    assert made["type"] == "report" and made["open_in_notestack"].endswith(f"/app/reports/{made['id']}")
    assert f"Used their notebook '{nb['title']}'" in made["scope_note"]
    done = make_artifact(db_session, "report", content={"title": "R", "blocks": []})
    assert "Do not write a separate report" in (await call(mcp, "get_artifact", artifact_id=str(done.id)))["present_it"]
    named = client.post("/api/notebooks", json={"title": "Weekly", "document_ids": []}, headers=auth).json()
    out = await call(mcp, "generate_quiz", notebook_id=named["id"])
    assert "'Weekly'" in out["scope_note"]
    listed = {t.name: t for t in await mcp.list_tools()}
    assert "never write your own report" in listed["generate_report"].description


QUESTIONS = [
    {"type": "multiple_choice", "question": "Why?", "options": ["a", "b"], "correct": [1], "explanation": "Because b.", "sources": [{"path": "secret/p.md"}]},
    {"type": "multiple_select", "question": "Which?", "options": ["a", "b", "c"], "correct": [0, 2], "explanation": ""},
    {"type": "fill_blank", "question": "The ___ swarm", "answer": "Navier", "accepted": ["navier-stokes"], "explanation": "x"},
    {"type": "short_answer", "question": "Explain.", "answer": "Because.", "explanation": ""},
] * 20


def test_the_quiz_widget_gets_notestacks_questions_and_answers_only():
    from app.mcp import widgets

    out = widgets.quiz_payload({"status": "ready", "title": "Quiz", "content": {"questions": QUESTIONS}}, "http://x/open")
    assert out["kind"] == "quiz" and len(out["questions"]) == widgets.MAX_QUESTIONS and out["open_url"] == "http://x/open"
    first, fill = out["questions"][0], out["questions"][2]
    assert first["options"] == ["a", "b"] and first["correct"] == [1] and first["explanation"] == "Because b."
    assert fill["answer"] == "Navier" and fill["accepted"] == ["navier-stokes"] and "secret/" not in json.dumps(out)
    assert widgets.quiz_payload({"status": "generating", "content": {}}, "u")["questions"] == []


def test_the_infographic_widget_gets_the_exact_pages_without_putting_them_in_model_content():
    art = {"id": "i1", "type": "infographic", "status": "ready", "title": "A picture",
           "content": {"html": "<main>portrait</main>", "html_landscape": "<main>landscape</main>"}}
    payload = widgets.infographic_payload(art, "http://x/open")
    assert payload["kind"] == "infographic" and payload["artifact_id"] == "i1"
    assert payload["html"] == "<main>portrait</main>" and payload["html_landscape"] == "<main>landscape</main>"
    assert "html" not in views.artifact_view(art, content=False)
    waiting = widgets.infographic_payload({"id": "i2", "status": "generating", "content": {}}, "u")
    assert waiting["html"] is None and "still being made" in waiting["message"]


def test_the_infographic_widget_hides_its_loading_state_after_rendering():
    from pathlib import Path

    page = (Path(__file__).parent.parent / "app" / "mcp" / "widgets" / "infographic.html").read_text()
    assert "[hidden] { display: none !important; }" in page
    assert '$("msg").hidden = true; $("page").hidden = false' in page


def test_the_quiz_page_is_self_contained():
    import re
    from pathlib import Path

    page = (Path(__file__).parent.parent / "app" / "mcp" / "widgets" / "quiz.html").read_text()
    assert not re.search(r"<script[^>]+src=|<link[^>]+href=|@import|url\(\s*['\"]?https?:|fetch\(|XMLHttpRequest|WebSocket", page)
    assert "innerHTML" not in page and "eval(" not in page and "e.source !== window.parent" in page and "ui/open-link" in page


@pytest.mark.anyio
async def test_show_quiz_plays_the_notestack_quiz_and_refuses_other_items(client, auth, as_writer, mcp, db_session):  # noqa: F811
    art = make_artifact(db_session, "quiz", content={"title": "Quiz", "questions": QUESTIONS[:4]})
    result = await call_raw(mcp, "show_quiz", artifact_id=str(art.id))
    assert result.structuredContent["kind"] == "quiz" and len(result.structuredContent["questions"]) == 4
    assert json.loads(result.content[0].text)["open_in_notestack"]
    cards = make_artifact(db_session, "flashcards", content={"title": "C", "cards": []})
    assert (await call(mcp, "show_quiz", artifact_id=str(cards.id)))["error"] == "not_a_quiz"


# Choosing a notebook and a video's options, and watching the video


@pytest.mark.anyio
async def test_the_writer_can_pick_a_notebook_or_make_a_new_one_from_a_list(client, auth, run_jobs, feed, as_writer, mcp):  # noqa: F811
    posts = _blog(client, auth, run_jobs)
    await call(mcp, "create_notebook", title="Weekly", document_ids=[posts[0]["id"]])
    client.post("/api/notebooks/archive", headers=auth)
    result = await call_raw(mcp, "choose_notebook", for_what="flashcards")
    seen = json.loads(result.content[0].text)
    assert "Do nothing until they answer" in seen["ask_writer"] and seen["options"][-1].endswith("(they choose its posts)")
    payload = result.structuredContent
    assert payload["kind"] == "notebook_picker" and payload["for_what"] == "flashcards"
    assert {n["title"] for n in payload["notebooks"]} == {"All posts", "Claude Weekly"}
    assert next(n for n in payload["notebooks"] if n["title"] == "Claude Weekly")["is_default"] is True
    assert {p["id"] for p in payload["posts"]} == {p["id"] for p in posts} and "path" not in json.dumps(payload)


def test_the_video_options_are_the_video_makers_own_choices():
    from app.mcp import widgets

    out = widgets.video_options_payload({
        "templates": [{"id": "default", "name": "Default", "preview_url": "https://x/p.webp", "secret": "no"}, {"name": "no id"}],
        "my_templates": [{"id": "custom_1", "name": "Mine"}], "video_styles": [{"id": "s1", "name": "Explainer"}],
        "languages": [{"code": "en", "name": "English"}]},
        {"saved": [{"voice_id": "v1", "name": "Rachel", "gender": "female", "accent": "american", "preview_url": "secret"}]})
    assert out["kind"] == "video_options" and [t["id"] for t in out["templates"]] == ["default", "custom_1"]
    assert out["templates"][1]["badge"] == "Yours" and out["languages"] == [{"code": "en", "name": "English"}]
    assert out["styles"][0]["id"] == "s1" and out["voices"] == [{"id": "v1", "name": "Rachel", "gender": "female", "accent": "american"}]
    assert "secret" not in json.dumps(out)


def test_the_video_view_plays_when_rendered_and_waits_when_not():
    from app.mcp import widgets

    done = widgets.video_payload("a1", "generating", "https://x.r2.dev/v.mp4", "T", "http://x/open")
    assert done["status"] == "ready" and done["video_url"].endswith("v.mp4") and done["artifact_id"] == "a1"
    waiting = widgets.video_payload("a1", "generating", None, "T", "http://x/open")
    assert waiting["status"] == "generating" and waiting["video_url"] is None
    preview = widgets.video_payload("a1", "generated", None, "T", "http://x/open",
                                    preview_url="https://blog2video.app/embed/token", ready=True,
                                    poll_url="https://api.test/p", poll_token="signed")
    assert preview["status"] == "ready" and preview["preview_url"].endswith("/embed/token")
    assert preview["poll_url"] == "https://api.test/p" and preview["poll_token"] == "signed"


@pytest.mark.anyio
async def test_generation_form_restores_the_artifact_it_created(client, auth, as_writer, mcp, db_session):  # noqa: F811
    form = await call_raw(mcp, "choose_options", make="mind_map")
    payload = form.structuredContent
    assert payload["state_url"] == "http://localhost:8000/api/mcp/widget-state"
    artifact = make_artifact(db_session, "mind_map", content={"title": "Map", "root": {"label": "Root"}})
    body = payload["state_token"] + "\n" + str(artifact.id)
    saved = client.post("/api/mcp/widget-state", content=body, headers={"Content-Type": "text/plain"})
    assert saved.status_code == 200 and saved.json()["artifact_id"] == str(artifact.id)
    restored = client.post("/api/mcp/widget-state", content=payload["state_token"],
                           headers={"Content-Type": "text/plain"})
    assert restored.json() == {"artifact_id": str(artifact.id), "kind": "mind_map", "status": "ready"}
    assert restored.headers["access-control-allow-origin"] == "*"


@pytest.mark.anyio
async def test_video_tools_open_the_players_and_the_options_form(mcp):  # noqa: F811
    listed = {t.name: t for t in await mcp.list_tools()}
    assert listed["generate_video"].meta == widgets.app_only({"ui": {"resourceUri": widgets.VIDEO_URI}})
    assert listed["get_video"].meta == {"ui": {"resourceUri": widgets.VIDEO_URI}}
    assert listed["choose_video_options"].meta == {"ui": {"resourceUri": widgets.VIDEO_OPTIONS_URI}}
    assert listed["choose_notebook"].meta == {"ui": {"resourceUri": widgets.PICKER_URI}}
    assert "choose_video_options" in listed["generate_video"].description and "never build a video yourself" in listed["generate_video"].description
    resources = {str(r.uri): r for r in await mcp.list_resources()}
    assert "domains" not in json.dumps(resources[widgets.VIDEO_URI].meta or {}) and \
        resources[widgets.VIDEO_URI].meta["ui"]["csp"]["resourceDomains"]


def test_the_new_pages_are_self_contained():
    import re
    from pathlib import Path

    for name in ("video_player", "video_options", "notebook_picker"):
        page = (Path(__file__).parent.parent / "app" / "mcp" / "widgets" / f"{name}.html").read_text()
        # Runtime API polling is allowed; self-contained means the widget has no
        # external scripts, stylesheets, font/image CSS imports, or socket clients.
        assert not re.search(r"<script[^>]+src=|<link[^>]+href=|@import|url\(\s*['\"]?https?:|XMLHttpRequest|WebSocket", page), name
        assert "innerHTML" not in page and "eval(" not in page and "e.source !== window.parent" in page, name
        if name == "video_player":
            assert "<iframe" not in page and 'id="preview" type="button"' in page


@pytest.mark.anyio
async def test_a_generation_can_use_only_some_of_a_notebooks_posts(client, auth, run_jobs, feed, as_writer, mcp, db_session):  # noqa: F811
    from sqlalchemy import select

    from app.models import Job

    posts = _blog(client, auth, run_jobs)
    nb = await call(mcp, "create_notebook", title="Mine", document_ids=[p["id"] for p in posts])
    first = posts[0]["id"]
    out = await call(mcp, "generate_quiz", notebook_id=nb["id"], post_ids=[first], wait_seconds=0)
    assert out["notebook_id"] == nb["id"] and out["type"] == "quiz"
    job = db_session.scalars(select(Job).order_by(Job.created_at.desc())).first()
    assert job.params["document_ids"] == [first]
    whole = await call(mcp, "generate_flashcards", notebook_id=nb["id"], wait_seconds=0)
    assert db_session.scalars(select(Job).order_by(Job.created_at.desc())).first().params["document_ids"] == []
    assert (await call(mcp, "generate_quiz", notebook_id=nb["id"], post_ids=["nope"], wait_seconds=0))["error"] == "bad_id"


def test_a_finished_report_is_trimmed_for_the_form():
    art = {"status": "ready", "title": "R", "content": {"title": "Briefing", "blocks": [
        {"type": "prose", "text": "## Hi\nbody"}, {"type": "mind_map", "title": "Map", "root": {"label": "x"}},
        {"type": "quiz", "questions": [{"question": f"q{i}"} for i in range(9)]}, {"type": "unknown"}]}}
    out = widgets.report_payload(art, "http://x")
    assert out["kind"] == "report" and out["title"] == "Briefing" and [b["type"] for b in out["blocks"]] == ["prose", "mind_map", "quiz"]
    assert "root" not in out["blocks"][1] and out["blocks"][2]["count"] == 9 and len(out["blocks"][2]["questions"]) == 6
    assert widgets.report_payload({"status": "failed"}, "http://x")["message"].startswith("Notestack could not")


REPORT_BLOCKS = [
    {"id": "b1", "type": "prose", "text": "## Why it matters\n\nA **bold** claim.\n\n- one\n- two", "path": "secret/p.md"},
    {"id": "b2", "type": "callout", "title": "Note", "text": "Careful."},
    {"id": "b3", "type": "key_terms", "terms": [{"term": "Swarm", "definition": "Many agents."}]},
    {"id": "b4", "type": "table", "headers": ["A", "B"], "rows": [["1", "2"]]},
    {"id": "b5", "type": "timeline", "events": [{"when": "2024", "title": "Start", "detail": "It began."}]},
    {"id": "b6", "type": "mind_map", "root": {"label": "Root", "children": [{"label": "Leaf", "children": []}]}},
    {"id": "b7", "type": "flashcards", "cards": [{"front": "Q", "back": "A"}]},
    {"id": "b8", "type": "quiz", "questions": QUESTIONS[:2]},
    {"id": "b9", "type": "infographic", "html": "<h1>big page</h1>", "artifact_id": "x"},
    {"id": "b10", "type": "unknown_block", "text": "dropped"},
]


def test_the_report_view_gets_the_whole_report_and_actionable_suggestions_but_no_paths_or_inline_pages():
    suggestion = {"id": "s1", "after_block_id": "b1", "kind": "mind_map", "brief": "Connect the ideas", "why": "A map helps."}
    art = {"id": "r1", "status": "ready", "title": "T", "adding": [{"suggestion_id": "s1", "status": "queued", "message": "Starting"}],
           "content": {"title": "My report", "format": "interactive", "blocks": REPORT_BLOCKS, "suggestions": [suggestion]}}
    out = widgets.report_view_payload(art, "http://x/open")
    text = json.dumps(out)
    assert out["kind"] == "report" and out["title"] == "My report" and out["format"] == "interactive" and out["open_url"] == "http://x/open"
    assert [b["type"] for b in out["blocks"]] == ["prose", "callout", "key_terms", "table", "timeline", "mind_map", "flashcards", "quiz", "infographic"]
    assert [b["id"] for b in out["blocks"]] == [f"b{i}" for i in range(1, 10)]
    assert out["suggestions"] == [suggestion] and out["adding"][0]["suggestion_id"] == "s1"
    assert "secret/" not in text and "big page" not in text and "unknown_block" not in text
    assert out["blocks"][7]["questions"][0]["options"] == ["a", "b"]
    waiting = widgets.report_view_payload({"id": "r1", "status": "generating", "content": {}}, "u")
    assert waiting["blocks"] == [] and "still being written" in waiting["message"]


@pytest.mark.anyio
async def test_view_report_shows_notestacks_report_and_refuses_other_items(client, auth, as_writer, mcp, db_session):  # noqa: F811
    art = make_artifact(db_session, "report", content={"title": "R", "format": "document", "blocks": REPORT_BLOCKS[:2]})
    result = await call_raw(mcp, "view_report", artifact_id=str(art.id))
    assert result.structuredContent["kind"] == "report" and len(result.structuredContent["blocks"]) == 2
    assert json.loads(result.content[0].text)["open_in_notestack"].endswith(f"/app/reports/{art.id}")
    quiz = make_artifact(db_session, "quiz", content={"title": "Q", "questions": []})
    assert (await call(mcp, "view_report", artifact_id=str(quiz.id)))["error"] == "not_a_report"


def test_the_report_page_is_self_contained_and_text_views_stay_inline():
    import re
    from pathlib import Path

    folder = Path(__file__).parent.parent / "app" / "mcp" / "widgets"
    page = (folder / "report.html").read_text()
    assert not re.search(r"<script[^>]+src=|<link[^>]+href=|@import|url\(\s*['\"]?https?:|fetch\(|XMLHttpRequest|WebSocket", page)
    assert "innerHTML" not in page and "eval(" not in page and "e.source !== window.parent" in page
    assert 'name: "add_report_block"' in page and 'suggestion_id: s.id' in page and 'name: "view_report"' in page
    assert 'var PLAYERS = /*__PLAYERS__*/{}' in page
    assert 'mind_map: "show_mind_map"' in page and 'quiz: "show_quiz"' in page and 'flashcards: "show_flashcards"' in page
    assert 'frame.srcdoc = PLAYERS[b.type]' in page and 'artifact_id: b.artifact_id' in page
    assert "#1c2a63" not in page and "background-color: #000" in page
    for name in ("flashcards.html", "quiz.html", "report.html", "generation_options.html"):
        text = (folder / name).read_text()
        assert "ui/request-display-mode" not in text and 'id="expand"' not in text and 'id="resexpand"' not in text, name


def test_the_report_form_reads_the_finished_report_in_place_without_an_overlay():
    from pathlib import Path

    page = (Path(__file__).parent.parent / "app" / "mcp" / "widgets" / "generation_options.html").read_text()
    assert 'call("view_report"' in page
    assert 'id="resexpand"' not in page and "ui/request-display-mode" not in page
    assert 'data.make === "report"' in page and "play(id)" in page
    assert 'report: "view_report"' in page and 'm.method === "tools/call"' in page
    assert "sendFollowUpMessage" not in page


def test_the_generation_form_becomes_an_output_only_view_and_renders_visual_media():
    from pathlib import Path

    page = (Path(__file__).parent.parent / "app" / "mcp" / "widgets" / "generation_options.html").read_text()
    assert 'classList.add("output-only")' in page
    assert 'body.output-only #where, body.output-only #setup' in page
    assert 'body.output-only.single-result #box { display: none; }' in page
    assert 'body.output-only.single-result #out { margin-top: 0; padding: 0; border: 0; border-radius: 0; background: transparent; }' in page
    assert 'classList.add("single-result")' in page and 'classList.remove("single-result")' in page
    assert "Change settings" not in page and "Make another" not in page
    assert 'id="again"' not in page and "leaveOutput" not in page
    assert 'id="expand"' not in page and "expandBtn" not in page
    assert 'id="resexpand"' not in page
    assert "restoreState()" in page and "window.openai.setWidgetState" in page
    assert 'className = "video-preview"' not in page and '"preview-url"' in page
    assert 'request("ui/message"' not in page  # form actions stay inside the App; no user bubble can expose call arguments
    assert 'data.make === "infographic"' in page and 'data.make === "audio_overview"' in page
    assert 'data.make === "slide_deck"' in page and 'v.slide_urls' in page
    assert 'infographic: "show_infographic"' in page
    assert 'placeholder="Search all notebooks"' in page and 'class="grid notebook-grid"' in page


def test_the_generation_form_all_posts_choice_enables_next_without_a_notebook_id():
    from pathlib import Path

    page = (Path(__file__).parent.parent / "app" / "mcp" / "widgets" / "generation_options.html").read_text()
    assert "(!archiveMode && !pickNb)" in page
    assert 'args.archive = true' in page


def test_the_infographic_player_uses_the_same_starry_surface_as_reports():
    from pathlib import Path

    page = (Path(__file__).parent.parent / "app" / "mcp" / "widgets" / "infographic.html").read_text()
    assert "background-color: #000" in page
    assert "radial-gradient(1.5px 1.5px at 8% 14%" in page


def test_template_cards_use_the_preview_base_url_when_it_is_set(monkeypatch):
    from app.config import settings
    from app.mcp import options, widgets

    catalog = {"templates": [{"id": "nebula", "name": "Nebula", "preview_url": "https://app/old.png"}]}
    monkeypatch.setattr(settings, "mcp_template_preview_base_url", "")
    assert options.video_fields(catalog)[0]["options"][0]["img"] == "https://app/old.png"  # unset: the app's own picture
    monkeypatch.setattr(settings, "mcp_template_preview_base_url", "https://cdn.example.dev/mcp-ui/template-previews/")
    card = options.video_fields(catalog)[0]["options"][0]
    assert card["img"] == "https://cdn.example.dev/mcp-ui/template-previews/nebula.png"
    assert card["fallback_img"] == "https://app/old.png"
    widget_template = widgets.video_options_payload(catalog)["templates"][0]
    assert widget_template["preview_url"].endswith("/nebula.png")
    assert widget_template["fallback_preview_url"] == "https://app/old.png"
    report = options.report_fields({"templates": [{"id": "brief", "name": "Brief"}]})[1]["options"]
    assert "img" not in report[1]  # report templates are text choices, not visual/video templates
    assert widgets._preview_domains() == ["https://cdn.example.dev"]  # the chat view may load pictures from there


def test_the_video_form_offers_the_writers_saved_voices_with_previews_instead_of_male_or_female():
    from app.mcp import options

    voices = {"saved": [{"voice_id": "v1", "name": "Connor", "preview_url": "https://x/connor.mp3", "gender": "male", "accent": "british"},
                        {"voice_id": "v2", "name": "Hale", "preview_url": "https://x/hale.mp3", "gender": None, "accent": None}]}
    fields = {f["key"]: f for f in options.form("video", {}, voices)["fields"]}
    assert "voice_gender" not in fields
    v = fields["voice"]
    assert v["type"] == "voices" and v["none_label"] == "No voiceover" and v["default"] == "v1"
    assert [o["label"] for o in v["options"]] == ["Connor", "Hale"] and v["options"][0]["preview"] == "https://x/connor.mp3"
    assert v["options"][0]["gender"] == "male" and v["options"][0]["accent"] == "british" and v["options"][1]["gender"] is None
    plain = {f["key"]: f for f in options.form("video", {}, None)["fields"]}  # no voice list: the male or female choice stays
    assert "voice" not in plain and plain["voice_gender"]["type"] == "chips"
