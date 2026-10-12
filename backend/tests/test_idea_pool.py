"""Flashcards (always) and quizzes (above ARTIFACT_MAX_POSTS posts) made from the ideas already extracted from each post
(pipeline/idea_pool.py). The model is always faked here."""

import random
import re
import uuid

import pytest
from sqlalchemy import select

from app.config import settings
from app.corpus import Corpus
from app.llm import run
from app.models import Document, Job, Workspace
from app.pipeline import idea_pool
from app.pipeline.material import load_material, max_posts
from app.services import report_suggestions
from tests.conftest import last_code

THEMES = ["Pricing", "Audience Growth", "Writing Craft"]


@pytest.fixture()
def owner(client, db_session):
    client.post("/api/auth/email/register/start", json={"email": "ada@example.com", "password": "stardust-42", "name": "Ada"})
    r = client.post("/api/auth/email/register/verify", json={"email": "ada@example.com", "code": last_code()})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}, db_session.scalar(select(Workspace))


def make_posts(db, ws, n: int, *, with_ideas: int | None = None, ideas_each: int = 3, start: int = 0, body: int = 11) -> list[Document]:
    """n indexed posts in the corpus, spread over three themes; the first `with_ideas` have stored ideas (all by default)."""
    with_ideas = n if with_ideas is None else with_ideas
    files, docs = {}, []
    for i in range(start, start + n):
        theme = THEMES[i % len(THEMES)]
        lines = ["---", f'title: "Post {i}"', "---", "", f"# Post {i}", ""] + [f"Sentence {k} about {theme.lower()} in post {i}." for k in range(1, body + 1)]
        path = f"sources/x/post-{i}.md"
        files[path] = "\n".join(lines) + "\n"
        d = Document(workspace_id=ws.id, title=f"Post {i} on {theme}", url=f"https://x.test/{i}", path=path, content_hash=f"h{i}",
                     clean_text=" ".join(lines), metadata_json={})
        if i - start < with_ideas:
            d.metadata_json = {"ideas_hash": f"h{i}", "ideas": [
                {"label": f"{theme} idea {i}.{k}", "note": f"What post {i} says about {theme.lower()}.",
                 "sources": [{"path": path, "line_start": 7 + k, "line_end": 9 + k}], "details": []} for k in range(ideas_each)]}
        db.add(d)
        docs.append(d)
    db.commit()
    Corpus(ws.id).write_files(files)
    return docs


def idea_lines(material: list[str]) -> list[str]:
    return [m for m in material if m.startswith("IDEA [")]


def test_a_sample_is_small_cited_and_spread_over_the_posts(owner, db_session):
    _, ws = owner
    docs = make_posts(db_session, ws, 60)
    material = idea_pool.sample(db_session, ws.id, docs, rng=random.Random(1))
    lines = idea_lines(material)
    assert material[0] == idea_pool.FORMAT_NOTE and len(lines) == settings.artifact_idea_sample == 30
    assert sum(len(m) for m in material) < 8_000  # about 1,500 tokens, whatever the size of the selection
    assert all(re.fullmatch(r"IDEA \[sources/x/post-\d+\.md lines \d+-\d+\] .+ idea \d+\.\d: What post \d+ says about .+\.", m) for m in lines)
    per_post = [m.split("[")[1].split(" ")[0] for m in lines]
    assert max(per_post.count(p) for p in set(per_post)) <= idea_pool.IDEAS_PER_POST and len(set(per_post)) >= 15
    assert lines != idea_lines(idea_pool.sample(db_session, ws.id, docs, rng=random.Random(2)))  # a fresh draw each time
    assert lines == idea_lines(idea_pool.sample(db_session, ws.id, docs, rng=random.Random(1)))  # the same draw for the same seed
    assert db_session.scalars(select(Job)).all() == []  # nothing is queued or extracted here


def test_a_small_selection_sends_all_its_ideas_and_a_topic_comes_first(owner, db_session):
    _, ws = owner
    few = make_posts(db_session, ws, 3, ideas_each=5)  # 15 ideas, fewer than the sample: all of them, however many per post
    assert len(idea_lines(idea_pool.sample(db_session, ws.id, few))) == 15
    docs = make_posts(db_session, ws, 30, start=100)
    picked = idea_lines(idea_pool.sample(db_session, ws.id, docs, topic="audience growth", size=10, rng=random.Random(3)))
    assert len(picked) == 10 and all("audience growth" in m.lower() for m in picked)  # ten of the matching ideas, before any other


def test_posts_with_no_ideas_get_a_short_opening_and_chats_only_their_end(owner, db_session):
    _, ws = owner
    docs = make_posts(db_session, ws, 12, with_ideas=5)
    material = idea_pool.sample(db_session, ws.id, docs, chats=["x" * 50_000, "y" * 50_000], rng=random.Random(4))
    openings = [m for m in material if m.startswith("FILE ")]
    assert len(openings) == idea_pool.MAX_OPENINGS and all(len(o) < 1_100 for o in openings)
    assert [len(m) for m in material[-2:]] == [idea_pool.CHAT_BUDGET // 2] * 2
    assert db_session.scalars(select(Job)).all() == []


def test_limits_and_budgets_come_from_settings(owner, db_session, monkeypatch):
    from app.pipeline.passages import passages_for

    assert max_posts() == 20
    monkeypatch.setattr(settings, "artifact_max_posts", 5)
    assert max_posts() == 5
    monkeypatch.undo()
    _, ws = owner
    docs = make_posts(db_session, ws, 20, with_ideas=0, body=300)  # long posts: each fills whatever it is given
    text = lambda: sum(len(p) for p in passages_for(Corpus(ws.id), docs))  # noqa: E731
    full = text()
    assert 20 * 5_500 < full < 20 * 6_500  # 120,000 characters shared by 20 posts: about 6,000 each
    monkeypatch.setattr(settings, "artifact_passage_budget", 40_000)
    mid = text()
    assert 20 * 1_500 < mid < 20 * 2_500  # 2,000 each
    monkeypatch.setattr(settings, "artifact_passage_budget", 1)  # the floor is 1,500 characters a post
    assert 20 * 1_000 < text() < mid


def _notebook(client, owner, docs):
    headers, _ = owner
    return client.post("/api/notebooks", json={"title": "Big", "document_ids": [str(d.id) for d in docs]}, headers=headers).json()


def test_when_ideas_are_used_instead_of_the_posts_text(owner, db_session):
    _, ws = owner
    nb = uuid.uuid4()  # an unknown notebook: only the picked posts count
    big = make_posts(db_session, ws, 30)
    ids = [str(d.id) for d in big]
    quiz_20 = load_material(db_session, ws.id, nb, {"document_ids": ids[:20]}, what="quiz", large_ok=True)
    assert quiz_20.mode == "passages" and len(quiz_20.text) == 20  # up to the limit: the text, exactly as before
    quiz_30 = load_material(db_session, ws.id, nb, {"document_ids": ids}, what="quiz", large_ok=True)
    assert quiz_30.mode == "ideas" and len(quiz_30.docs) == 30 and quiz_30.text == []
    report = load_material(db_session, ws.id, nb, {"document_ids": ids}, what="report")
    assert report.mode == "passages" and len(report.docs) == 20  # a report still reads its first posts' text
    cards_3 = load_material(db_session, ws.id, nb, {"document_ids": ids[:3]}, what="flashcard set", large_ok=True, ideas_always=True)
    assert cards_3.mode == "ideas" and len(cards_3.docs) == 3  # flashcards: always the ideas, even from three posts
    # Ideas not stored yet: the posts' text is read (the first 20 when there are more), as it always was
    bare = make_posts(db_session, ws, 30, with_ideas=0, start=200)
    bare_ids = [str(d.id) for d in bare]
    assert load_material(db_session, ws.id, nb, {"document_ids": bare_ids}, what="quiz", large_ok=True).mode == "passages"
    big_bare = load_material(db_session, ws.id, nb, {"document_ids": bare_ids}, what="quiz", large_ok=True)
    assert len(big_bare.docs) == 20 and len(big_bare.text) == 20
    few_bare = load_material(db_session, ws.id, nb, {"document_ids": bare_ids[:3]}, what="flashcard set", large_ok=True, ideas_always=True)
    assert few_bare.mode == "passages" and len(few_bare.text) == 3
    # Half or more with ideas: the ideas, and a short opening for the rest
    half = make_posts(db_session, ws, 4, with_ideas=2, start=300)
    assert load_material(db_session, ws.id, nb, {"document_ids": [str(d.id) for d in half]}, what="flashcard set", large_ok=True,
                         ideas_always=True).mode == "ideas"


def _cited(inputs: dict) -> list[dict]:
    """A source for each idea line, copied from its tag the way the model is told to."""
    tags = [re.match(r"IDEA \[(\S+) lines (\d+)-(\d+)\]", m) for m in inputs["material"]]
    return [{"path": t[1], "line_start": int(t[2]), "line_end": int(t[3])} for t in tags if t]


def test_a_big_quiz_is_one_call_over_a_sample_of_ideas(client, owner, db_session, run_jobs, monkeypatch):
    headers, ws = owner
    docs = make_posts(db_session, ws, 40)
    nb = _notebook(client, owner, docs)
    calls: list[dict] = []

    def predict(signature, *, db, workspace_id, job=None, lm=None, **inputs):
        assert signature.__name__ == "GenerateQuiz"
        calls.append(inputs)
        cited = _cited(inputs)
        return {"questions": [{"type": "multiple_choice", "question": f"Question {k}?", "options": ["a", "b"], "correct": [0],
                               "explanation": "", "sources": [cited[k]]} for k in range(inputs["count"])]}

    monkeypatch.setattr(run, "predict", predict)
    monkeypatch.setattr(run, "predict_many", lambda *a, **k: pytest.fail("one call"))
    art = client.post("/api/artifacts/generate", json={"type": "quiz", "notebook_id": nb["id"], "document_ids": [str(d.id) for d in docs],
                      "question_types": ["multiple_choice"]}, headers=headers).json()
    run_jobs()
    done = client.get(f"/api/artifacts/{art['id']}", headers=headers).json()
    assert done["status"] == "ready", done["content"]
    assert len(calls) == 1 and calls[0]["count"] == 10 and calls[0]["material"][0] == idea_pool.FORMAT_NOTE
    assert len(idea_lines(calls[0]["material"])) == 30
    qs = done["content"]["questions"]
    assert len(qs) == 10 and all(q["sources"] and q["sources"][0]["document_id"] and q["sources"][0]["quote"] for q in qs)  # lines verified
    assert len(done["content"]["source"]["document_ids"]) == 40
    assert db_session.scalars(select(Job).where(Job.kind == "ideas")).all() == []


def test_flashcards_use_the_ideas_for_any_size_of_selection_but_not_for_chats(client, owner, db_session, run_jobs, monkeypatch):
    headers, ws = owner
    docs = make_posts(db_session, ws, 3, ideas_each=4)
    nb = _notebook(client, owner, docs)
    calls: list[list[str]] = []

    def predict(signature, *, db, workspace_id, job=None, lm=None, **inputs):
        calls.append(inputs["material"])
        cited = _cited(inputs) or [{"path": docs[0].path, "line_start": 1, "line_end": 2}]
        return {"cards": [{"front": f"Front {k}", "back": "Back.", "sources": [cited[k % len(cited)]]} for k in range(inputs["count"])]}

    monkeypatch.setattr(run, "predict", predict)
    art = client.post("/api/artifacts/generate", json={"type": "flashcards", "notebook_id": nb["id"],
                      "document_ids": [str(d.id) for d in docs]}, headers=headers).json()
    run_jobs()
    done = client.get(f"/api/artifacts/{art['id']}", headers=headers).json()
    assert done["status"] == "ready" and done["content"]["card_count"] == 16
    assert calls[0][0] == idea_pool.FORMAT_NOTE and len(idea_lines(calls[0])) == 12  # all twelve ideas, no post text
    assert not any(m.startswith("FILE ") for m in calls[0])
    assert all(c["sources"] and c["sources"][0]["document_id"] for c in done["content"]["cards"])


def test_a_quiz_or_flashcards_take_any_number_of_posts_and_the_limits_are_served(client, owner, db_session, monkeypatch):
    headers, ws = owner
    docs = make_posts(db_session, ws, 130)
    ids = [str(d.id) for d in docs]
    nb = _notebook(client, owner, docs)
    assert client.get("/api/settings/limits", headers=headers).json() == {"posts": 20}
    big = load_material(db_session, ws.id, uuid.UUID(nb["id"]), {"document_ids": ids}, what="quiz", large_ok=True)
    assert big.mode == "ideas" and len(big.docs) == 130 and big.text == []  # all of them count; the sample stays the same size
    assert len(idea_lines(idea_pool.sample(db_session, ws.id, big.docs))) == settings.artifact_idea_sample
    cap = load_material(db_session, ws.id, uuid.UUID(nb["id"]), {"document_ids": ids}, what="report")
    assert len(cap.docs) == 20  # a report still reads its first posts
    monkeypatch.setattr(run, "predict", lambda *a, **k: {"questions": []})
    for kind in ("quiz", "flashcards"):  # no refusal for a big selection
        r = client.post("/api/artifacts/generate", json={"type": kind, "notebook_id": nb["id"], "document_ids": ids}, headers=headers)
        assert r.status_code == 200, r.text


def test_a_passage_leaves_out_the_file_header_and_keeps_the_line_numbers(owner, db_session):
    from app.pipeline.passages import passages_for

    _, ws = owner
    doc = make_posts(db_session, ws, 1, with_ideas=0)[0]
    text = passages_for(Corpus(ws.id), [doc])[0]
    assert text.startswith(f"FILE {doc.path} ({doc.title})\n7| Sentence 1 about")  # no ---, title, url, date or "# Post" lines
    assert "---" not in text and "# Post" not in text and "title:" not in text
    assert "11| Sentence 5" in text  # numbered as in the file, so a cited line is still the right one


def test_a_quiz_reads_posts_with_its_own_smaller_budget(client, owner, db_session, run_jobs, monkeypatch):
    headers, ws = owner
    docs = make_posts(db_session, ws, 20, with_ideas=0, body=300)
    nb = _notebook(client, owner, docs)
    sizes: dict[str, int] = {}

    def predict(signature, *, db, workspace_id, job=None, lm=None, **inputs):
        sizes[signature.__name__] = sum(len(m) for m in inputs["material"])
        raise RuntimeError("stop here: only the size of what was sent is wanted")

    monkeypatch.setattr(run, "predict", predict)
    ids = [str(d.id) for d in docs]
    for kind in ("quiz", "report"):
        client.post("/api/artifacts/generate", json={"type": kind, "notebook_id": nb["id"], "document_ids": ids}, headers=headers)
    run_jobs()
    assert settings.artifact_quiz_passage_budget == 60_000
    assert sizes["GenerateQuiz"] < 0.6 * sizes["WriteReport"]  # a quiz's 60,000 characters against a report's 120,000



def test_suggested_report_templates_read_each_posts_stored_summary(client, owner, db_session, monkeypatch):
    headers, ws = owner
    docs = make_posts(db_session, ws, 6, with_ideas=4, ideas_each=6)  # the last two posts have no stored ideas yet
    for d in docs[:4]:
        d.metadata_json = {**d.metadata_json, "topics": [{"name": "Pricing", "weight": 0.9}, {"name": "Growth", "weight": 0.5}]}
    db_session.commit()
    seen: list[dict] = []

    def predict(signature, *, db, workspace_id, job=None, lm=None, **inputs):
        assert signature.__name__ == "SuggestReportTemplates"
        seen.append(inputs)
        return {"templates": [{"name": f"Template {n}", "description": "d", "prompt": "p"} for n in range(4)]}

    monkeypatch.setattr(run, "predict", predict)
    r = client.post("/api/reports/suggest", json={"document_ids": [str(d.id) for d in docs]}, headers=headers)
    assert r.status_code == 200 and len(r.json()["templates"]) == 4
    items = seen[0]["items"]
    assert len(items) == report_suggestions.SUGGEST_ITEMS  # at most this many sources, however many are selected (newest first)
    summaries = [i for i in items if "\n- " in i]
    starts = [i for i in items if "\n- " not in i]
    assert len(summaries) == 2 and len(starts) == 2  # the two newest posts have no stored ideas: read by their start
    for item in summaries:
        ideas = report_suggestions.SUMMARY_IDEAS
        assert "Topics: Pricing, Growth" in item and item.count("\n- ") == ideas and len(item) <= report_suggestions.SUMMARY_CHARS
        assert " idea " in item and "Sentence 1 about" not in item  # the stored ideas, not the post text
    assert all("Sentence" in i for i in starts)
    # A post with no stored ideas is still read, by its start
    r = client.post("/api/reports/suggest", json={"document_ids": [str(docs[13].id)]}, headers=headers)
    assert r.status_code == 200 and "Sentence" in seen[1]["items"][0]


def test_the_fast_models_output_cap_is_a_setting():
    from app.llm.provider import fast_lm

    assert settings.llm_fast_max_tokens == 6000 and fast_lm().kwargs["max_tokens"] == 6000  # quizzes and flashcards write under 3,000
