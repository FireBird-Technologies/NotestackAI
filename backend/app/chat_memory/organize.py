"""The write path of chat memory: after an answer, a background job files the new rounds of a chat under topics and
updates each topic's summary, keywords and exact quotes.

The database stays the source of truth for what was said. The model only chooses: which topic a round belongs to,
what to write in a summary, and which messages (by short labels like m4) are worth keeping. Code does the rest: it
maps labels back to real messages, copies the quotes out of the database word for word, validates everything the
model returned, and writes the files in an order that makes a crash harmless (topic files, then the notebook index,
then TOPICS.md with the `through` pointer last)."""

import logging
import re
import uuid
from dataclasses import dataclass, field
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.chat_memory import files
from app.chat_memory.files import INDEX, TOPICS, Quote, Topic, TopicEntry, TopicsFile
from app.chat_memory.logs import context_log, job_log, text_enabled
from app.config import settings
from app.corpus import Corpus, CorpusError
from app.llm import run
from app.llm.provider import fast_lm
from app.llm.signatures import OrganizeChat
from app.models import Chat, Job, Message, Notebook
from app.services.jobs import create_job, utcnow

log = logging.getLogger(__name__)

WRITER_CHARS = 600  # per message sent to the model
ASSISTANT_CHARS = 900
SUMMARIES_SHOWN = 12  # topics whose current summary is shown to the model
SUMMARY_SHOWN_CHARS = 700
FALLBACK_TOPIC = "General chat"
# A new topic whose words overlap an existing topic's this much is the same topic, so its rounds join that one.
MERGE_OVERLAP = 0.5  # shared words as a share of the smaller of the two word sets
MERGE_MIN_SHARED = 4  # and at least this many shared words, so two short lists cannot match by luck
REFUSAL_OPENING = "I only answer from the posts in this notebook"  # the canned off-topic reply, for rows saved before kinds


def chat_corpus(workspace_id: uuid.UUID, notebook_id: uuid.UUID, store=None, cache_dir: str | None = None) -> Corpus:
    """The notebook's chat area: its own manifest, disk cache and R2 prefix `ws/{workspace}/chats/{notebook}/`."""
    return Corpus(workspace_id, store=store, cache_dir=cache_dir, area=f"chats/{notebook_id}")


# Rounds


@dataclass
class Round:
    label: str  # r1, r2, ...
    writer: Message | None
    assistant: Message | None

    @property
    def messages(self) -> list[Message]:
        return [m for m in (self.writer, self.assistant) if m is not None]


def ordered_messages(db: Session, chat_id: uuid.UUID) -> list[Message]:
    """Oldest first. On a timestamp tie the writer's message comes before the reply ("user" sorts after "assistant")."""
    return list(db.scalars(select(Message).where(Message.chat_id == chat_id)
                           .order_by(Message.created_at, Message.role.desc())))


def after_through(messages: list[Message], through: str) -> list[Message]:
    if not through:
        return messages
    for i, m in enumerate(messages):
        if str(m.id) == through:
            return messages[i + 1:]
    return messages  # the pointer names a message that is gone: start over rather than lose the chat


def pair_rounds(messages: list[Message]) -> list[Round]:
    """A writer message with the assistant message after it. A trailing writer message with no reply yet is left
    for the next run, so its answer is filed together with it."""
    rounds: list[Round] = []
    i = 0
    while i < len(messages):
        m = messages[i]
        if m.role == "user":
            nxt = messages[i + 1] if i + 1 < len(messages) else None
            if nxt is not None and nxt.role == "assistant":
                rounds.append(Round("", m, nxt))
                i += 2
                continue
            if nxt is None:
                break  # waiting for the answer
            rounds.append(Round("", m, None))
        else:
            rounds.append(Round("", None, m))
        i += 1
    for n, r in enumerate(rounds, start=1):
        r.label = f"r{n}"
    return rounds


def _post_paths(m: Message) -> list[str]:
    return sorted({c.path for c in m.citations if getattr(c, "kind", "post") == "post"})


def render_rounds(rounds: list[Round]) -> tuple[str, dict[str, Message]]:
    """The prompt text for the rounds, and the table from short labels (m1, m2) back to real messages. The model
    never sees or writes a real id."""
    labels: dict[str, Message] = {}
    out: list[str] = []
    n = 0
    for r in rounds:
        out.append(r.label)
        for m in r.messages:
            n += 1
            label = f"m{n}"
            labels[label] = m
            if m.role == "user":
                out.append(f"{label} Writer: {files.squeeze(m.content, WRITER_CHARS)}")
            else:
                out.append(f"{label} Assistant: {files.squeeze(files.strip_markers(m.content), ASSISTANT_CHARS)}")
                posts = _post_paths(m)
                if posts:
                    out.append(f"    (posts used: {', '.join(posts)})")
        out.append("")
    return "\n".join(out).strip(), labels


# Reading the current state


def read_topics_file(corpus: Corpus, chat_id: uuid.UUID | str) -> TopicsFile:
    path = files.chat_path(chat_id, TOPICS)
    try:
        if corpus.exists(path):
            tf = files.parse_topics("\n".join(corpus.read_lines(path)))
            tf.chat_id = tf.chat_id or str(chat_id)
            return tf
    except (CorpusError, OSError):
        log.warning("Unreadable %s, starting that chat's topics over", path, exc_info=True)
    return TopicsFile(chat_id=str(chat_id))


def read_topic(corpus: Corpus, chat_id: uuid.UUID | str, slug: str) -> Topic | None:
    path = files.topic_path(chat_id, slug)
    try:
        return files.parse_topic("\n".join(corpus.read_lines(path))) if corpus.exists(path) else None
    except (CorpusError, OSError):
        return None


def topics_prompt(corpus: Corpus, chat_id: uuid.UUID | str, tf: TopicsFile) -> tuple[str, set[str]]:
    """The topics so far for the model, and which of them had their summary shown."""
    if not tf.entries:
        return "(none)", set()
    entries = sorted(tf.entries, key=lambda e: e.last, reverse=True)
    lines = [f"{e.slug} | {e.label} | {e.gist} | {e.keywords}" for e in entries]
    shown: set[str] = set()
    blocks: list[str] = []
    for e in entries[:SUMMARIES_SHOWN]:
        topic = read_topic(corpus, chat_id, e.slug)
        if topic and topic.summary:
            shown.add(e.slug)
            blocks.append(f"Summary of {e.slug}: {files.squeeze(topic.summary, SUMMARY_SHOWN_CHARS)}")
    return "\n".join(lines + [""] + blocks), shown


# Reading the model's answer


@dataclass
class Plan:
    """What the model decided, checked against reality: slug -> rounds, plus the update for each slug."""

    rounds: dict[str, list[Round]] = field(default_factory=dict)
    labels: dict[str, str] = field(default_factory=dict)  # slug -> label for topics that are new
    updates: dict[str, dict] = field(default_factory=dict)
    extend: set[str] = field(default_factory=set)  # existing topics a new topic was merged into: extend, not replace
    merged: dict[str, str] = field(default_factory=dict)  # new slug -> the existing slug it was folded into


def _resolve(raw: str, known: dict[str, str], plan: Plan) -> str | None:
    """A slug for the model's topic string, or None for SKIP. `known` maps slug -> label for existing topics."""
    raw = (raw or "").strip()
    if not raw or raw.upper() == "SKIP":
        return None
    if raw.upper().startswith("NEW:"):
        label = raw[4:].strip() or FALLBACK_TOPIC
    elif raw in known or raw in plan.labels:
        return raw
    else:
        label = raw.replace("-", " ").strip() or FALLBACK_TOPIC
    slug = files.topic_slug(label)
    if slug not in known:
        plan.labels.setdefault(slug, label[:80])
    return slug


# Answers that were not about the writer's posts: the question was turned down, answered from the app's help text, or
# was small talk. They say nothing about the posts, and filing them adds a topic every later message has to be weighed
# against. `kind` is saved with every answer (recall_json) by the chat endpoint.
NOT_ABOUT_THE_POSTS = {"off_topic", "about_app", "chitchat", "error"}  # error: the "please send that again" reply


def is_off_topic(r: Round) -> bool:
    """True when the assistant's answer was not about the posts (see NOT_ABOUT_THE_POSTS), so the round is not filed."""
    a = r.assistant
    if a is None:
        return False
    kind = (a.recall_json or {}).get("kind")
    if kind:
        return kind in NOT_ABOUT_THE_POSTS
    return not a.citations and a.content.strip().startswith(REFUSAL_OPENING)  # an answer saved before kinds existed


_STOPWORDS = {"the", "and", "for", "with", "from", "that", "this", "what", "how", "about", "post", "posts", "chat",
              "writer", "assistant", "question", "answer", "per", "its", "are", "was", "has", "have"}


def _tokens(text: str) -> set[str]:
    """Lower case words, with a plural s dropped, so "agents" and "agent" count as one word."""
    words = re.findall(r"[a-z0-9]+", text.lower())
    return {w[:-1] if len(w) > 4 and w.endswith("s") else w for w in words if len(w) >= 3 and w not in _STOPWORDS}


def merge_close_topics(plan: Plan, tf: TopicsFile) -> None:
    """Fold a brand new topic into an existing one when their keywords mostly agree. The model reads a short topic
    list and tends to open a fresh topic for a follow up that really continues an old one, which splits one subject
    across several files. Different questions on a related theme (few shared words) stay apart."""
    for slug in [s for s in plan.labels if s in plan.rounds and not tf.get(s)]:
        update = plan.updates.get(slug) or {}
        mine = _tokens(f"{plan.labels[slug]} {' '.join(str(k) for k in update.get('keywords') or [])}")
        best: tuple[float, int, str] | None = None
        for e in tf.entries:
            theirs = _tokens(f"{e.label} {e.keywords}")
            shared = len(mine & theirs)
            score = shared / max(min(len(mine), len(theirs)), 1)
            if shared >= MERGE_MIN_SHARED and score >= MERGE_OVERLAP and (best is None or score > best[0]):
                best = (score, shared, e.slug)
        if best is None:
            continue
        target = best[2]
        plan.rounds.setdefault(target, []).extend(plan.rounds.pop(slug))
        plan.rounds[target].sort(key=lambda r: int(r.label[1:]))
        plan.labels.pop(slug, None)
        plan.updates.pop(slug, None)
        plan.merged[slug] = target
        there = plan.updates.get(target)
        if there is None:
            # The model wrote this summary for the new topic alone: it is added to the old one, and the old gist stays.
            plan.updates[target] = {k: v for k, v in update.items() if k not in {"topic", "gist"}} | {"topic": target}
            plan.extend.add(target)
        else:  # the model also updated the old topic in this run: join the two updates
            there["summary"] = f"{there.get('summary', '')} {update.get('summary', '')}".strip()
            there["keywords"] = list(there.get("keywords") or []) + list(update.get("keywords") or [])
            there["keep"] = list(there.get("keep") or []) + list(update.get("keep") or [])
        job_log.info("chat memory: new topic '%s' overlaps '%s' (%d shared words, %.0f%%), so its rounds were filed "
                     "there instead", slug, target, best[1], best[0] * 100)


def _is_small_talk(r: Round) -> bool:
    """SKIP is for greetings and thanks only. The model is asked that, but a real follow up it skipped is not lost."""
    return r.writer is not None and bool(files.SMALL_TALK.match(r.writer.content))


def build_plan(out: dict, batch: list[Round], labels: dict[str, Message], tf: TopicsFile) -> Plan:
    plan = Plan()
    known = {e.slug: e.label for e in tf.entries}
    by_label = {r.label: r for r in batch}
    chosen: dict[str, str | None] = {}  # round label -> slug, or None for SKIP
    for a in out.get("assignments") or []:
        label = str(a.get("round", "")).strip()
        if label in by_label and label not in chosen:
            chosen[label] = _resolve(a.get("topic", ""), known, plan)
    previous = max(tf.entries, key=lambda e: e.last).slug if tf.entries else None
    for r in batch:  # a round the model forgot, or skipped though it is a real question, is filed with the one before
        if r.label not in chosen or (chosen[r.label] is None and not _is_small_talk(r)):
            chosen[r.label] = previous or _resolve(f"NEW:{FALLBACK_TOPIC}", known, plan)
        if chosen[r.label] is not None:
            previous = chosen[r.label]
            plan.rounds.setdefault(chosen[r.label], []).append(r)
    for u in out.get("updates") or []:
        slug = _resolve(u.get("topic", ""), known, plan)
        if slug is not None and slug in plan.rounds:  # an update for a topic that got no rounds is ignored
            plan.updates[slug] = u
    for rs in plan.rounds.values():
        rs.sort(key=lambda r: int(r.label[1:]))
    merge_close_topics(plan, tf)
    return plan


def _date(m: Message) -> str:
    return m.created_at.date().isoformat() if m.created_at else utcnow().date().isoformat()


def _quote(m: Message) -> Quote:
    text = m.content if m.role == "user" else files.strip_markers(m.content)
    text = text.strip()
    if len(text) > files.MAX_VERBATIM_CHARS:
        text = text[:files.MAX_VERBATIM_CHARS].rstrip() + " [...]"
    return Quote(str(m.id), "writer" if m.role == "user" else "assistant", _date(m), text)


def apply_plan(plan: Plan, existing: dict[str, Topic], shown: set[str], chat_id: str,
               labels: dict[str, Message], position: dict[str, int]) -> dict[str, Topic]:
    """The new state of every topic that got rounds. Quotes are copied from the database here, by code.

    `position` maps a message id to its place in the chat. A topic file remembers the newest message filed in it, so
    after a crash that left topic files written but the pointer unmoved, the rerun skips the rounds already counted
    instead of counting them twice."""
    result: dict[str, Topic] = {}
    for slug, rounds in plan.rounds.items():
        topic = existing.get(slug) or Topic(label=plan.labels.get(slug, slug.replace("-", " ")), slug=slug,
                                            chat_id=chat_id)
        done_to = position.get(topic.last_message, -1)
        fresh = [r for r in rounds if position[str(r.messages[-1].id)] > done_to]
        msgs = [m for r in rounds for m in r.messages]
        dates = sorted(_date(m) for m in msgs)
        topic.first = min(filter(None, [topic.first, dates[0]]))
        topic.last = max(filter(None, [topic.last, dates[-1]]))
        topic.rounds += len(fresh)
        topic.recent = (topic.recent + [str(m.id) for r in fresh for m in r.messages])[-files.MAX_RECENT:]
        topic.last_message = str(max((r.messages[-1] for r in rounds), key=lambda m: position[str(m.id)]).id)
        update = plan.updates.get(slug) or {}
        new_summary = files.clean_summary(update.get("summary", ""), settings.chat_memory_summary_chars)
        if not new_summary:
            if not topic.summary:  # a new topic the model gave no summary for: say what was asked
                first = next((m.content for m in msgs if m.role == "user"), msgs[0].content)
                new_summary = f"The writer asked: {files.squeeze(first, 240)}"
        elif topic.summary and slug not in shown:  # the model never saw the old summary, so extend instead of replace
            new_summary = files.clean_summary(f"{topic.summary} {new_summary}", settings.chat_memory_summary_chars)
        topic.summary = new_summary or topic.summary
        topic.gist = files.one_line(update.get("gist", "") or topic.gist or topic.label)
        topic.keywords = files.clean_keywords(list(update.get("keywords") or []) + topic.keywords)
        allowed = {id(m): m for m in msgs}
        wanted: list[Message] = []
        for label in update.get("keep") or []:
            m = labels.get(str(label).strip())
            if m is not None and id(m) in allowed and m not in wanted:  # only messages from this topic's rounds
                wanted.append(m)
        topic.verbatim = _merge_quotes(topic.verbatim, [_quote(m) for m in wanted])
        result[slug] = topic
    return result


def _merge_quotes(old: list[Quote], new: list[Quote]) -> list[Quote]:
    new_ids = {q.message_id for q in new}
    merged = [q for q in old if q.message_id not in new_ids] + new
    while len(merged) > files.MAX_VERBATIM:
        drop = next((i for i, q in enumerate(merged) if q.message_id not in new_ids), 0)
        merged.pop(drop)
    return merged


def entry_for(t: Topic) -> TopicEntry:
    return TopicEntry(slug=t.slug, label=t.label, last=t.last, rounds=t.rounds, keywords=", ".join(t.keywords),
                      gist=t.gist)


# The job


def _lock_notebook(db: Session, notebook_id: uuid.UUID) -> None:
    """Hold the notebook row (FOR UPDATE on Postgres) while writing, so two chats of one notebook cannot overwrite
    each other's manifest or the notebook index. Released by the next commit. Held only for the file writes, never
    for the model call."""
    db.scalar(select(Notebook.id).where(Notebook.id == notebook_id).with_for_update())


def other_chats(corpus: Corpus, manifest: dict[str, str], chat_id: str) -> dict[str, list[TopicEntry]]:
    out: dict[str, list[TopicEntry]] = {}
    for rel in manifest:
        chat, _, name = rel.partition("/")
        if name == TOPICS and chat != chat_id:
            out[chat] = read_topics_file(corpus, chat).entries
    return out


def organize_chat(db: Session, job: Job | None, chat: Chat, corpus: Corpus | None = None,
                  requeue: bool = True) -> dict:
    """File the chat's new rounds under topics. Safe to run twice: the result depends only on the database and the
    `through` pointer, and the pointer moves last."""
    corpus = corpus or chat_corpus(chat.workspace_id, chat.notebook_id)
    chat_id = str(chat.id)
    corpus.sync()
    tf = read_topics_file(corpus, chat_id)
    start_through = tf.through
    ordered = ordered_messages(db, chat.id)
    rounds = pair_rounds(after_through(ordered, start_through))
    if not rounds:
        job_log.info("chat memory: chat %s has nothing new to file (through=%s)", chat_id[:8], start_through[:8] or "-")
        return {"rounds": 0, "topics": 0, "more": False}
    batch = rounds[:max(settings.chat_memory_max_rounds_per_job, 1)]
    more = len(rounds) > len(batch)
    job_log.info("chat memory: filing %d of %d waiting round(s) of chat %s (notebook %s), through=%s, "
                 "%d topic(s) so far", len(batch), len(rounds), chat_id[:8], str(chat.notebook_id)[:8],
                 start_through[:8] or "-", len(tf.entries))

    # Rounds that were not about the posts (turned down, app help, small talk) are never filed, so they reach neither
    # the model nor R2. They still count as handled: the pointer moves past them below.
    work = [r for r in batch if not is_off_topic(r)]
    if len(work) < len(batch):
        job_log.info("chat memory: %d round(s) of chat %s were not about the posts (kind %s) and are not filed",
                     len(batch) - len(work), chat_id[:8], "/".join(sorted(NOT_ABOUT_THE_POSTS)))
    topics_text, shown = topics_prompt(corpus, chat_id, tf)
    rounds_text, labels = render_rounds(work)
    out = run.predict(OrganizeChat, db=db, workspace_id=chat.workspace_id, job=job, lm=fast_lm(),
                      topics=topics_text, rounds=rounds_text) if work else {}
    plan = build_plan(out, work, labels, tf)
    shown -= plan.extend  # a merged-in summary covers only the new rounds, so it is added to the old one
    # Only topics listed in TOPICS.md are real. A topic file that is not listed was left by a run that crashed before
    # the pointer moved, so it is rebuilt from scratch instead of being extended.
    existing = {slug: t for slug in plan.rounds if tf.get(slug) and (t := read_topic(corpus, chat_id, slug))}
    position = {str(m.id): i for i, m in enumerate(ordered)}
    old_chars = {slug: len(t.summary) for slug, t in existing.items()}  # apply_plan edits these topics in place
    topics = apply_plan(plan, existing, shown, chat_id, labels, position)
    previous = tf.current
    for r in batch:  # in order: a change of topic between one round and the next is a switch
        slug = next((s for s, rs in plan.rounds.items() if r in rs), None)
        if slug is None:
            continue
        if previous and slug != previous:
            known = topics.get(previous) or tf.get(previous)  # filed in this batch, or listed from an earlier one
            job_log.info("=== TOPIC SWITCHED while filing chat %s: '%s' -> '%s' (round %s) ===", chat_id[:8],
                         known.label if known else previous, topics[slug].label, r.label)
        previous = slug
    tf.current = previous or tf.current
    job_log.info("chat memory: model %s filed the rounds as %s", fast_lm().model,
                 {slug: [r.label for r in rs] for slug, rs in plan.rounds.items()} or "no topic (small talk only)")
    for slug, topic in topics.items():
        job_log.info("=== SUMMARY %s: topic '%s' (%s) %s -> %d chars ===", "CHANGED" if slug in existing else "CREATED",
                     topic.label, slug, f"{old_chars[slug]}" if slug in existing else "new", len(topic.summary))
        job_log.info("chat memory: summary %s for topic '%s' (%s): %d round(s), summary %d chars, %d exact quote(s), "
                     "%d keyword(s)", "UPDATED" if slug in existing else "CREATED", topic.label, slug, topic.rounds,
                     len(topic.summary), len(topic.verbatim), len(topic.keywords))
        if text_enabled():
            context_log.info("chat memory: new summary of '%s':\n%s\nkeywords: %s", topic.label, topic.summary,
                             ", ".join(topic.keywords))

    for slug, topic in topics.items():
        tf.entries = [e for e in tf.entries if e.slug != slug] + [entry_for(topic)]
    tf.through = str(batch[-1].messages[-1].id)
    tf.updated = utcnow().isoformat()

    _lock_notebook(db, chat.notebook_id)
    manifest = corpus.sync()  # inside the lock: other chats' latest files, and a compare and set on `through`
    if read_topics_file(corpus, chat_id).through != start_through:
        db.rollback()
        job_log.warning("chat memory: chat %s skipped: another run moved the pointer while this one was working",
                        chat_id[:8])
        return {"rounds": 0, "topics": 0, "more": False, "skipped": "another run moved the pointer"}
    per_chat = other_chats(corpus, manifest, chat_id)
    per_chat[chat_id] = tf.entries
    # Order matters: topic files and the index first, the pointer last. A crash before the last write leaves the old
    # pointer, so the next run files the same rounds again and writes the same files.
    topic_files = {files.topic_path(chat_id, s): files.render_topic(t) for s, t in topics.items()}
    index_text, topics_text = files.render_index(per_chat), files.render_topics(tf)
    corpus.write_files({**topic_files, INDEX: index_text})
    corpus.write_files({files.chat_path(chat_id, TOPICS): topics_text})
    for rel, body in [*topic_files.items(), (INDEX, index_text), (files.chat_path(chat_id, TOPICS), topics_text)]:
        job_log.info("chat memory: wrote to R2: %s (%d bytes)", corpus._key(rel), len(body.encode()))
    job_log.info("chat memory: chat %s through pointer moved %s -> %s", chat_id[:8], start_through[:8] or "-",
                 tf.through[:8])
    db.commit()
    if more and requeue:
        create_job(db, chat.workspace_id, "chat_memory", {"chat_id": chat_id}, max_attempts=2,
                   run_after=utcnow() + timedelta(seconds=1))
    return {"rounds": len(batch), "topics": len(topics), "more": more}


def forget_chat(workspace_id: uuid.UUID, notebook_id: uuid.UUID, chat_id: uuid.UUID, db: Session | None = None,
                corpus: Corpus | None = None) -> int:
    """Remove a deleted chat's files and its lines in the notebook index. Returns the number of files removed."""
    corpus = corpus or chat_corpus(workspace_id, notebook_id)
    if db is not None:
        _lock_notebook(db, notebook_id)
    manifest = corpus.sync()
    gone = {rel for rel in manifest if rel.startswith(f"{chat_id}/")}
    if not gone:
        return 0
    per_chat = other_chats(corpus, manifest, str(chat_id))
    corpus.write_files({INDEX: files.render_index(per_chat)}, remove=gone)
    job_log.info("chat memory: removed %d file(s) of chat %s from R2 and rebuilt %s", len(gone), str(chat_id)[:8],
                 corpus._key(INDEX))
    if db is not None:
        db.commit()
    return len(gone)


def queue_chat_memory(db: Session, workspace_id: uuid.UUID, chat_id: uuid.UUID) -> Job | None:
    """Queue one memory job for the chat unless one is already waiting. A job that is already running does not count:
    it may have read the messages before the newest answer was saved."""
    if not (settings.chat_memory_enabled and settings.llm_api_key):
        return None
    waiting = db.scalars(select(Job).where(Job.workspace_id == workspace_id, Job.kind == "chat_memory",
                                           Job.status == "queued")).all()
    if any((j.params or {}).get("chat_id") == str(chat_id) for j in waiting):
        return None
    return create_job(db, workspace_id, "chat_memory", {"chat_id": str(chat_id)}, max_attempts=2,
                      run_after=utcnow() + timedelta(seconds=settings.chat_memory_delay_seconds))


def rebuild_chat(db: Session, job: Job | None, chat: Chat, corpus: Corpus | None = None) -> dict:
    """Throw away a chat's memory and build it again from its messages: for a lost or damaged R2 area, or after the
    prompt changes. Costs one model call per batch of rounds."""
    corpus = corpus or chat_corpus(chat.workspace_id, chat.notebook_id)
    forget_chat(chat.workspace_id, chat.notebook_id, chat.id, db, corpus)
    total = {"rounds": 0, "topics": 0}
    while True:
        done = organize_chat(db, job, chat, corpus, requeue=False)
        total["rounds"] += done["rounds"]
        total["topics"] = max(total["topics"], done["topics"])
        if not done["more"]:
            return total


def forget_orphans(db: Session, workspace_id: uuid.UUID, notebook_id: uuid.UUID, corpus: Corpus | None = None) -> int:
    """Remove memory for chats that no longer exist (a deletion whose cleanup failed, or a database restore). Returns
    the number of chat folders removed."""
    corpus = corpus or chat_corpus(workspace_id, notebook_id)
    folders = {rel.partition("/")[0] for rel in corpus.sync() if "/" in rel}
    live = {str(i) for i in db.scalars(select(Chat.id).where(Chat.notebook_id == notebook_id))}
    orphans = sorted(folders - live)
    for folder in orphans:
        try:
            forget_chat(workspace_id, notebook_id, uuid.UUID(folder), db, corpus)
        except ValueError:  # not a chat folder: leave it alone
            continue
    return len(orphans)
