"""The help bot: scope gate, escalation nets, retrieval, UI guides, the stream endpoint and the contact form.
The model is always faked here; real answers are read with tests/evals/support_live.py."""

import json
import re
import uuid
from pathlib import Path

import pytest

from app.config import settings
from app.models import SupportConversation, SupportMessage
from app.routers import support as support_router
from app.services.email import ConsoleEmailProvider
from app.support import escalation as esc
from app.support import llm, scope
from app.support.corpus import get_corpus
from app.support.retriever import get_retriever
from tests.conftest import last_code

FRONTEND = Path(__file__).resolve().parents[2] / "frontend" / "src"


@pytest.fixture()
def auth(client):
    client.post("/api/auth/email/register/start", json={"email": "ada@example.com", "password": "stardust-42", "name": "Ada L"})
    r = client.post("/api/auth/email/register/verify", json={"email": "ada@example.com", "code": last_code()})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture(autouse=True)
def _reset_rate_limit():
    support_router._hits.clear()


def sse(text: str) -> list[tuple[str, object]]:
    events = []
    for block in text.strip().split("\n\n"):
        lines = block.split("\n")
        events.append((lines[0][len("event: "):], json.loads(lines[1][len("data: "):])))
    return events


def answer_text(events) -> str:
    return "".join(d for e, d in events if e == "token")


def done(events) -> dict:
    return next(d for e, d in events if e == "done")


@pytest.fixture()
def fake_llm(monkeypatch):
    """Scripted model: .answer is streamed in two pieces, .meta is the labelling call. Records every prompt."""
    class Fake:
        answer = "Open **Sources** and paste your link.\n\n1. Paste the link.\n2. Click **Connect**."
        meta = {"citations": ["sources-and-syncing"], "escalate": False}
        fail_stream = False
        prompts: list = []
        summary_calls = 0

    fake = Fake()
    fake.prompts = []

    async def stream_answer(messages):
        fake.prompts.append(messages)
        if fake.fail_stream:
            raise llm.LLMError("down")
        half = len(fake.answer) // 2
        yield fake.answer[:half]
        yield fake.answer[half:]

    async def complete_text(messages, max_tokens=600):
        fake.summary_calls += 1
        return "The writer is learning how to add sources."

    async def complete_meta(messages):
        return llm.Meta.model_validate(fake.meta)

    monkeypatch.setattr(llm, "stream_answer", stream_answer)
    monkeypatch.setattr(llm, "complete_text", complete_text)
    monkeypatch.setattr(llm, "complete_meta", complete_meta)
    return fake


def chat(client, auth, message, **extra):
    r = client.post("/api/support/chat/stream", json={"message": message, **extra}, headers=auth)
    assert r.status_code == 200, r.text
    return sse(r.text)


# ---- scope: never the writer's own data ---------------------------------------------------------------------

def test_scrub_path_removes_ids_and_queries():
    assert scope.scrub_path("/app/notebooks/3f2b8c1e-9d4a-4c7e-8a11-0b5c6d7e8f90") == "/app/notebooks/:id"
    assert scope.scrub_path("/app/notebooks/3f2b8c1e-9d4a-4c7e-8a11-0b5c6d7e8f90?chat=1#x") == "/app/notebooks/:id"
    assert scope.scrub_path("/app/sources") == "/app/sources"
    assert scope.scrub_path("https://evil.example/x") is None
    assert scope.scrub_path(None) is None


@pytest.mark.parametrize("message", [
    "what did I write about pricing?",
    "summarize my notebook",
    "How many posts do I have?",
    "show me my posts about AI",
    "why did my video fail",
    "which of my articles mention onboarding",
    "what's in my archive",
    "what is in my notebook",
    "list my sources",
    "compare my last two posts",
    "tell me what I said about churn",
    "what did we talk about earlier?",
    "what did we discuss in my last chat",
    "recap my previous conversation",
    "what did the notebook say about pricing in our chat",
])
def test_questions_about_the_writers_own_content_are_blocked(message):
    assert scope.about_user_data(message), message


@pytest.mark.parametrize("message", [
    "how do I add my blog?",
    "how do I delete my notebook",
    "How can I connect my Substack",
    "where do I find my launch kits",
    "can I upload my pdf files",
    "what is a notebook?",
    "what does the free plan include",
    "which plan has voice cloning",
    "hi",
    "how do I make an audio overview of my posts",
    "what formats can I upload",
    "how do I start a new chat",
    "how do I see my chat history",
    "where is the chat sidebar",
])
def test_product_how_to_questions_pass(message):
    assert not scope.about_user_data(message), message


def test_out_of_scope_reply_points_to_the_notebook_chat_and_offers_help_when_broken():
    reply, broken = scope.out_of_scope_reply("what did I write about pricing?")
    assert "notebook" in reply and not broken and "pass it to our team" not in reply
    reply, broken = scope.out_of_scope_reply("why did my video fail")
    assert broken and "pass it to our team" in reply
    assert "—" not in reply


# ---- escalation nets ----------------------------------------------------------------------------------------

@pytest.mark.parametrize("message,reason", [
    ("I want to talk to a human", esc.Reason.HUMAN),
    ("get me a representative", esc.Reason.HUMAN),
    ("support", esc.Reason.HUMAN),
    ("you are useless", esc.Reason.HUMAN),
    ("I JUST WANT A REFUND", esc.Reason.REFUND),
    ("this is a billing dispute", esc.Reason.REFUND),
    ("will you ever add Ghost newsletters", esc.Reason.FEATURE),
    ("feature request: dark mode for the player", esc.Reason.FEATURE),
])
def test_escalation_fires(message, reason):
    assert esc.classify_question(message) is reason


@pytest.mark.parametrize("message", [
    "what formats do you support",
    "do you support pdf uploads",
    "how do I add a source",
    "how much does the writer plan cost",
    "how do I cancel my subscription",
])
def test_escalation_stays_quiet_on_product_questions(message):
    assert esc.classify_question(message) is None


def test_only_human_and_refund_skip_the_docs():
    assert esc.should_short_circuit(esc.Reason.HUMAN) and esc.should_short_circuit(esc.Reason.REFUND)
    assert not esc.should_short_circuit(esc.Reason.FEATURE) and not esc.should_short_circuit(None)


@pytest.mark.parametrize("line,safe", [
    ("Sure, use the form below and the team will email you.", True),
    ("I've sent this to our team.", False),
    ("I have forwarded your request.", False),
    ("You are now connected to a live agent.", False),
    ("I've opened a ticket for you.", False),
])
def test_handoff_lines_that_claim_an_action_are_rejected(line, safe):
    assert esc.handoff_line_is_safe(line) is safe


# ---- corpus and retrieval -----------------------------------------------------------------------------------

def test_corpus_docs_are_complete():
    docs = get_corpus()
    assert len(docs) >= 12 and len({d.id for d in docs}) == len(docs)
    for d in docs:
        assert d.title and d.route.startswith("/") and d.body and d.keywords and d.questions, d.id
        assert "—" not in d.body + d.title, f"em dash in {d.id}"


def test_corpus_routes_are_real_routes():
    app_tsx = (FRONTEND / "App.tsx").read_text(encoding="utf-8")
    paths = set(re.findall(r'path="([^"]+)"', app_tsx))
    real = {"/", "/app"} | {p if p.startswith("/") else f"/app/{p}" for p in paths}
    for d in get_corpus():
        for route in (d.route, *d.related_paths):
            assert route in real, f"{d.id} points at {route}, which is not a route"


def test_plan_doc_matches_the_plan_table():
    from app.services.plans import PLANS

    body = next(d for d in get_corpus() if d.id == "plans-and-billing").body
    for p in PLANS.values():
        assert p.name in body
        if p.price_monthly_usd:
            assert f"${p.price_monthly_usd:g}" in body
        assert str(p.indexed_posts) in body


@pytest.mark.parametrize("question,expected", [
    ("how do I connect my substack", "sources-and-syncing"),
    ("how do I upload a pdf", "sources-and-syncing"),
    ("what file types can I upload", "sources-and-syncing"),
    ("what do the numbers in brackets mean in answers", "notebooks-and-chat"),
    ("how do I make an audio overview", "audio-and-video"),
    ("how do I make a quote card", "audio-and-video"),
    ("what is a launch kit", "launch-kit"),
    ("how do I schedule a post to linkedin", "launchpad"),
    ("why did I get an email reminder instead of an auto post", "launchpad"),
    ("how does voice cloning work", "voice-profile"),
    ("what is the topic map", "topic-map-and-resurfacing"),
    ("how do I add my logo and brand colors", "settings-and-account"),
    ("how do I delete my account", "settings-and-account"),
    ("how much does the writer plan cost", "plans-and-billing"),
    ("what is in the free plan", "plans-and-billing"),
    ("does it work on mobile", "troubleshooting"),
    ("is it a notebooklm alternative", "what-notestack-does-not-do"),
])
def test_retrieval_finds_the_right_doc(question, expected):
    hits = get_retriever().retrieve(question)
    assert hits and hits[0].doc.id == expected, [(h.doc.id, round(h.score, 1)) for h in hits]


def test_retrieval_returns_nothing_for_unrelated_text():
    assert get_retriever().retrieve("capital of france population soccer") == []


def test_the_current_page_breaks_a_tie():
    on_launchpad = get_retriever().retrieve("how do I connect an account", page_path="/app/launchpad")
    assert on_launchpad[0].doc.id == "launchpad"


def test_a_short_follow_up_borrows_the_earlier_question():
    hits = get_retriever().retrieve("and on the free plan?", history=["how many sources can I connect"])
    assert hits[0].doc.id in {"plans-and-billing", "sources-and-syncing"}


# ---- the stream endpoint ------------------------------------------------------------------------------------

def test_chat_requires_sign_in(client):
    assert client.post("/api/support/chat/stream", json={"message": "hi"}).status_code == 401
    assert client.get("/api/support/conversations/latest").status_code == 401
    assert client.post("/api/support/escalate", json={"email": "a@b.co", "concern": "x"}).status_code == 401


def test_a_normal_question_streams_then_finishes_with_citations_and_a_guide(client, auth, fake_llm, db_session):
    events = chat(client, auth, "how do I add my blog?", page_path="/app/notebooks")
    names = [e for e, _ in events]
    assert names == ["token", "token", "answer_done", "done"]
    assert "Connect" in answer_text(events)
    payload = done(events)
    assert payload["citations"] == ["sources-and-syncing"]
    assert "ui_guidance" not in payload and "navigation" not in payload  # written instructions only, no tour
    assert payload["escalate"] is False
    conv = db_session.get(SupportConversation, uuid.UUID(payload["conversation_id"]))
    rows = db_session.query(SupportMessage).filter_by(conversation_id=conv.id).order_by(SupportMessage.created_at).all()
    assert [m.role for m in rows] == ["user", "assistant"] and rows[1].cited_docs == ["sources-and-syncing"]
    assert conv.session_state["current_page"] == "/app/notebooks" and conv.session_state["plan"]


def test_the_bot_is_told_to_give_written_navigation_only(client, auth, fake_llm):
    chat(client, auth, "how do I add my blog?")
    system = fake_llm.prompts[0][0]["content"]
    assert "left sidebar" in system and "you only give written instructions" in system


def test_the_prompt_is_grounded_in_the_docs_and_has_no_notebook_ids(client, auth, fake_llm, db_session):
    notebook = "3f2b8c1e-9d4a-4c7e-8a11-0b5c6d7e8f90"
    chat(client, auth, "how do I add my blog?", page_path=f"/app/notebooks/{notebook}?chat=abc")
    system = fake_llm.prompts[0][0]["content"]
    assert "--- id: sources-and-syncing" in system
    assert notebook not in json.dumps(fake_llm.prompts)
    assert "/app/notebooks/:id" in fake_llm.prompts[0][-1]["content"]
    assert all(notebook not in (m.page_path or "") for m in db_session.query(SupportMessage))


def test_questions_about_the_writers_own_work_never_reach_the_model(client, auth, fake_llm):
    events = chat(client, auth, "what did I write about pricing?")
    assert fake_llm.prompts == []
    assert "can't see your notebooks" in answer_text(events)
    assert done(events)["citations"] == [] and not done(events)["escalate"]


def test_a_broken_work_question_offers_the_human_form(client, auth, fake_llm):
    payload = done(chat(client, auth, "why did my video fail"))
    assert fake_llm.prompts == [] and payload["escalate"] and payload["escalate_reason"] == "human"


def test_a_how_to_with_my_in_it_is_still_answered(client, auth, fake_llm):
    chat(client, auth, "how do I delete my notebook")
    assert len(fake_llm.prompts) == 1


def test_asking_for_a_person_skips_the_docs_and_offers_the_form(client, auth, fake_llm):
    fake_llm.answer = "Of course, use the form below and the team will get back to you."
    events = chat(client, auth, "I want to talk to a human")
    payload = done(events)
    assert payload["escalate"] and payload["escalate_reason"] == "human"
    assert "--- id:" not in fake_llm.prompts[0][0]["content"]  # no documents in the hand off prompt
    assert answer_text(events) == fake_llm.answer


def test_a_handoff_that_lies_is_replaced(client, auth, fake_llm):
    fake_llm.answer = "I've sent this to our team and opened a ticket."
    events = chat(client, auth, "I need a refund")
    assert "sent" not in answer_text(events) and "ticket" not in answer_text(events)
    assert done(events)["escalate_reason"] == "refund"


def test_a_feature_request_is_answered_and_gets_the_feature_form(client, auth, fake_llm):
    fake_llm.answer = "That is not available today. I can pass the idea to our team."
    fake_llm.meta = {"citations": [], "escalate": False}
    payload = done(chat(client, auth, "will you ever add Ghost newsletters"))
    assert payload["escalate"] and payload["escalate_reason"] == "feature"
    assert len(fake_llm.prompts) == 1


def test_an_answer_that_offers_the_team_triggers_the_form_even_if_labelling_fails(client, auth, fake_llm, monkeypatch):
    fake_llm.answer = "I'm not sure about that. I can pass this to our team if you'd like."

    async def boom(messages):
        raise llm.LLMError("down")

    monkeypatch.setattr(llm, "complete_meta", boom)
    payload = done(chat(client, auth, "does it integrate with zapier"))
    assert payload["escalate"] and payload["citations"] == []


def test_the_label_call_cannot_cite_a_document_that_was_not_retrieved(client, auth, fake_llm):
    fake_llm.meta = {"citations": ["plans-and-billing", "invented-doc"], "escalate": False}
    payload = done(chat(client, auth, "how do I connect my substack"))
    assert "invented-doc" not in payload["citations"]


def test_model_down_sends_an_error_event_and_stores_nothing(client, auth, fake_llm, db_session):
    fake_llm.fail_stream = True
    events = chat(client, auth, "how do I add my blog?")
    assert events[-1][0] == "error" and "unavailable" in events[-1][1]
    assert db_session.query(SupportMessage).count() == 0


def test_em_dashes_from_the_model_are_stripped(client, auth, fake_llm):
    fake_llm.answer = "Open Sources — then paste the link."
    events = chat(client, auth, "how do I add my blog?")
    assert "—" not in answer_text(events)


def test_follow_ups_use_the_same_conversation_and_old_turns_fold_into_a_summary(client, auth, fake_llm, db_session):
    first = done(chat(client, auth, "how do I add my blog?"))
    cid = first["conversation_id"]
    for i in range(5):
        assert done(chat(client, auth, f"and how do I upload a pdf {i}", conversation_id=cid))["conversation_id"] == cid
    assert len(fake_llm.prompts[-1]) > 3  # history is in the prompt
    assert fake_llm.summary_calls >= 1
    db_session.expire_all()
    assert db_session.get(SupportConversation, uuid.UUID(cid)).summary


def test_nobody_else_can_use_or_read_your_conversation(client, auth, fake_llm):
    cid = done(chat(client, auth, "how do I add my blog?"))["conversation_id"]
    client.post("/api/auth/email/register/start", json={"email": "bob@example.com", "password": "stardust-42", "name": "Bob"})
    r = client.post("/api/auth/email/register/verify", json={"email": "bob@example.com", "code": last_code()})
    other = {"Authorization": f"Bearer {r.json()['access_token']}"}
    assert client.post("/api/support/chat/stream", json={"message": "hi", "conversation_id": cid}, headers=other).status_code == 404
    assert client.get("/api/support/conversations/latest", headers=other).json() == {"conversation_id": None, "messages": []}
    assert client.post("/api/support/escalate", json={"email": "b@x.co", "concern": "x", "conversation_id": cid},
                       headers=other).status_code == 404


def test_latest_conversation_restores_the_chat(client, auth, fake_llm):
    chat(client, auth, "how do I add my blog?")
    data = client.get("/api/support/conversations/latest", headers=auth).json()
    assert [m["role"] for m in data["messages"]] == ["user", "assistant"]
    assert data["messages"][1]["cited_docs"] == ["sources-and-syncing"]


def test_message_limits_and_rate_limit(client, auth, fake_llm, monkeypatch):
    assert client.post("/api/support/chat/stream", json={"message": ""}, headers=auth).status_code == 422
    assert client.post("/api/support/chat/stream", json={"message": "x" * 4001}, headers=auth).status_code == 422
    monkeypatch.setattr(settings, "support_messages_per_minute", 2)
    chat(client, auth, "how do I add my blog?")
    chat(client, auth, "how do I add my blog?")
    assert client.post("/api/support/chat/stream", json={"message": "hi"}, headers=auth).status_code == 429


def test_the_bot_can_be_switched_off(client, auth, monkeypatch):
    monkeypatch.setattr(settings, "support_enabled", False)
    assert client.post("/api/support/chat/stream", json={"message": "hi"}, headers=auth).status_code == 404


# ---- the contact form ---------------------------------------------------------------------------------------

def test_the_form_emails_the_team_with_the_recent_chat(client, auth, fake_llm):
    cid = done(chat(client, auth, "how do I add my blog?"))["conversation_id"]
    ConsoleEmailProvider.sent.clear()
    r = client.post("/api/support/escalate", headers=auth, json={
        "email": "ada@example.com", "concern": "My sync is stuck", "reason": "human", "conversation_id": cid,
        "page_path": "/app/notebooks/3f2b8c1e-9d4a-4c7e-8a11-0b5c6d7e8f90"})
    assert r.status_code == 202
    mail = ConsoleEmailProvider.sent[-1]
    assert mail.to == settings.alerts_email and mail.headers == {"Reply-To": "ada@example.com"}
    assert "My sync is stuck" in mail.text and "how do I add my blog?" in mail.text and "3f2b8c1e" not in mail.text
    assert "—" not in mail.text


def test_the_form_validates_and_is_capped_per_conversation(client, auth, fake_llm):
    cid = done(chat(client, auth, "how do I add my blog?"))["conversation_id"]
    assert client.post("/api/support/escalate", headers=auth, json={"email": "nope", "concern": "x"}).status_code == 422
    assert client.post("/api/support/escalate", headers=auth, json={"email": "a@b.co", "concern": "   "}).status_code == 422
    body = {"email": "a@b.co", "concern": "help", "conversation_id": cid}
    assert [client.post("/api/support/escalate", headers=auth, json=body).status_code for _ in range(4)] == [202, 202, 202, 429]


def test_the_support_package_never_touches_the_writers_content():
    forbidden = re.compile(r"\b(Document|Notebook|Chat|Message|Source|Artifact|Citation|NotebookDocument)\b")
    for path in [*Path(support_router.__file__).parent.parent.joinpath("support").glob("*.py"), Path(support_router.__file__)]:
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.startswith(("from app.models", "import app.models")):
                assert not forbidden.search(line), f"{path.name} imports the writer's content: {line}"
