"""Post cards: a short description of every post, written once by the fast model when the post is added or changed.

Keyword search only finds a post when the question uses the post's own words. A card adds the other words a reader
might use (topics, names with spelling variants, synonyms, the questions the post answers), and the chat's BM25
indexes them with the post (app/pipeline/prefetch.py), so "how do I get more paid subscribers" can find a post that
only says "converting free readers into paying members". It is the alternative to embeddings: no vector store, and
a card is rebuilt only when its post changes.

Cards live in the corpus next to the posts, as cards/<post path>.json (see corpus.card_rel), so they sync through the
same R2 manifest and go when their post is removed. They are never citable: answers still cite the posts' lines."""

import json
import logging
import uuid
from concurrent.futures import ThreadPoolExecutor

import dspy
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.corpus import Corpus, CorpusError, card_rel
from app.llm.provider import fast_lm
from app.models import Document
from app.pipeline.passages import _body_start

log = logging.getLogger(__name__)

CARD_VERSION = 1
HEAD_CHARS = 9_000  # the post given to the model: its start (where the argument usually is) ...
TAIL_CHARS = 3_000  # ... and its end (the conclusion)
WRITE_BATCH = 20  # cards written to the corpus per manifest update
MAX_PARALLEL = 4
LIMITS = {"topics": 8, "entities": 12, "synonyms": 20, "questions": 5}


class PostCard(dspy.Signature):
    """Describe one post from a writer's archive so that a keyword search finds it when a reader asks about it in
    their own words. Use only what the post says. Prefer the plain words a reader would type over the post's jargon,
    and include common spelling variants of names (for example "Arsalan" for "Arslan")."""

    title: str = dspy.InputField()
    post: str = dspy.InputField()
    summary: str = dspy.OutputField(desc="2 to 3 sentences: what the post says and its main claims")
    topics: list[str] = dspy.OutputField(desc="Up to 8 subjects, 1 to 4 words each")
    entities: list[str] = dspy.OutputField(desc="Up to 12 names: people, companies, products, tools, places")
    synonyms: list[str] = dspy.OutputField(desc="Up to 20 other words or short phrases a reader might use for the "
                                                "post's subjects")
    questions: list[str] = dspy.OutputField(desc="3 to 5 questions this post answers, in a reader's words")


def post_text(lines: list[str]) -> str:
    body = "\n".join(line for line in lines[_body_start(lines):] if line.strip())
    if len(body) <= HEAD_CHARS + TAIL_CHARS:
        return body
    return body[:HEAD_CHARS] + "\n[...]\n" + body[-TAIL_CHARS:]


def _clean(values, limit: int) -> list[str]:
    out = []
    for v in values or []:
        v = " ".join(str(v).split())[:120]
        if v and v.lower() not in {x.lower() for x in out}:
            out.append(v)
    return out[:limit]


def make_card(title: str, text: str) -> dict:
    with dspy.context(lm=fast_lm()):
        pred = dspy.Predict(PostCard)(title=title, post=text, config={"timeout": settings.llm_timeout_seconds})
    return {"version": CARD_VERSION, "title": title, "summary": " ".join((pred.summary or "").split())[:800],
            **{field: _clean(getattr(pred, field, None), limit) for field, limit in LIMITS.items()}}


def read_card(corpus: Corpus, post: str) -> dict | None:
    try:
        return json.loads("\n".join(corpus.read_lines(card_rel(post))))
    except (CorpusError, ValueError, OSError):
        return None


def load_cards(corpus: Corpus, posts) -> dict[str, dict]:
    """The cards on local disk for these posts (call corpus.sync first). Posts without a card are left out."""
    return {p: card for p in posts if (card := read_card(corpus, p)) is not None}


def card_terms(card: dict) -> str:
    """The card's text for the keyword index."""
    return " ".join([card.get("summary", ""), *[" ".join(card.get(f) or []) for f in LIMITS]])


def build_cards(corpus: Corpus, posts: dict[str, str], force: bool = False) -> dict:
    """Write cards for posts whose card is missing or was made from an older version of the post.
    posts: path -> title. Returns counts. One failed card never stops the others."""
    manifest = corpus.sync(tuple(posts))
    todo = []
    for path, title in posts.items():
        if path not in manifest:
            continue
        old = read_card(corpus, path)
        if force or not old or old.get("post_hash") != manifest[path] or old.get("version") != CARD_VERSION:
            todo.append((path, title))
    made = failed = 0
    pending: dict[str, str] = {}

    def one(item: tuple[str, str]) -> tuple[str, dict | None]:
        path, title = item
        try:
            card = make_card(title, post_text(corpus.read_lines(path)))
            return path, {**card, "post_hash": manifest[path]}
        except Exception:
            log.warning("Could not make the card for %s", path, exc_info=True)
            return path, None

    workers = max(1, min(MAX_PARALLEL, settings.llm_max_concurrent))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for path, card in pool.map(one, todo):
            if card is None:
                failed += 1
                continue
            pending[card_rel(path)] = json.dumps(card, ensure_ascii=False)
            made += 1
            if len(pending) >= WRITE_BATCH:
                corpus.write_files(pending)
                pending = {}
    if pending:
        corpus.write_files(pending)
    return {"made": made, "failed": failed, "up_to_date": len(posts) - len(todo)}


def cards_for_documents(db: Session, workspace_id: uuid.UUID, document_ids: list[str] | None,
                        force: bool = False) -> dict:
    """The worker's entry point: cards for these documents, or for every post in the workspace when ids is None."""
    q = select(Document.path, Document.title).where(Document.workspace_id == workspace_id, Document.path.is_not(None))
    if document_ids is not None:
        q = q.where(Document.id.in_([uuid.UUID(str(i)) for i in document_ids]))
    posts = {path: title or path for path, title in db.execute(q).all()}
    if not posts:
        return {"made": 0, "failed": 0, "up_to_date": 0}
    return build_cards(Corpus(workspace_id), posts, force)
