"""The file formats of chat memory, as pure functions: render and parse.

Layout, relative to the notebook's chat area (R2 `ws/{workspace}/chats/{notebook}/`):

    INDEX.md                    one line per topic across every chat of the notebook
    {chat_id}/TOPICS.md         this chat's topic list and the `through` pointer
    {chat_id}/{slug}.md         one file per topic: summary, then exact quotes

Every parser tolerates a missing or hand edited file by returning something empty, so one bad file never breaks a
chat."""

import re
import uuid
from dataclasses import dataclass, field

from app.corpus import slugify

TOPICS = "TOPICS.md"
INDEX = "INDEX.md"
MAX_TOPICS = 30  # lines kept in TOPICS.md; the least recently active are dropped from the list, never from the database
MAX_VERBATIM = 10
MAX_VERBATIM_CHARS = 1200
MAX_RECENT = 8  # message ids kept per topic: the last four rounds
MAX_KEYWORDS = 20

SMALL_TALK = re.compile(
    r"^\s*(hi|hey|hello|yo|hiya|good (morning|afternoon|evening)|thanks|thank you|thx|ty|cheers|ok(ay)?|"
    r"cool|great|nice|awesome|perfect|got it|sounds good|bye|goodbye|see you|lol|haha)[\s!.,:)]*$",
    re.IGNORECASE,
)
_MARKER = re.compile(r"\[(\d+)\]")
_VERBATIM_HEAD = re.compile(r"^\[([0-9a-fA-F-]{36}) (writer|assistant) (\d{4}-\d{2}-\d{2})\]$")


def chat_path(chat_id: uuid.UUID | str, name: str) -> str:
    return f"{chat_id}/{name}"


def topic_path(chat_id: uuid.UUID | str, slug: str) -> str:
    return chat_path(chat_id, f"{slug}.md")


def topic_slug(label: str) -> str:
    return slugify(label, max_len=48)


def one_line(text: str, limit: int = 200) -> str:
    """A value that sits on one `a | b | c` line: no newlines, no pipes."""
    return re.sub(r"\s+", " ", text.replace("|", "/")).strip()[:limit]


def squeeze(text: str, limit: int) -> str:
    """Shorten a long message by keeping its start and end, cut on word boundaries."""
    text = text.strip()
    if len(text) <= limit:
        return text
    half = limit // 2
    head, tail = text[:half], text[-half:]
    head = head.rsplit(" ", 1)[0] if " " in head else head
    tail = tail.split(" ", 1)[1] if " " in tail else tail
    return f"{head.rstrip()} ... {tail.lstrip()}"


def strip_markers(text: str) -> str:
    return re.sub(r"[ \t]+([.,;:!?])", r"\1", _MARKER.sub("", text))


def clean_keywords(words: list[str]) -> list[str]:
    seen: dict[str, None] = {}
    for w in words:
        w = one_line(str(w), 40).lower().replace(",", " ").strip()
        if w and w not in seen:
            seen[w] = None
    return list(seen)[:MAX_KEYWORDS]


def _front_matter(text: str) -> tuple[dict[str, str], str]:
    """(key: value pairs, the rest) of a file that starts with a --- block."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, text
    meta: dict[str, str] = {}
    for i, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            return meta, "\n".join(lines[i + 1:])
        if ":" in line:
            key, _, value = line.partition(":")
            meta[key.strip()] = value.strip()
    return {}, text  # never closed: treat the file as unreadable front matter


# TOPICS.md


@dataclass
class TopicEntry:
    slug: str
    label: str
    last: str  # YYYY-MM-DD of the last round
    rounds: int
    keywords: str  # comma separated
    gist: str


@dataclass
class TopicsFile:
    chat_id: str = ""
    through: str = ""  # id of the last message processed, "" before the first run
    current: str = ""  # slug of the topic the newest filed round went to: what the chat was just talking about
    updated: str = ""
    entries: list[TopicEntry] = field(default_factory=list)

    def get(self, slug: str) -> TopicEntry | None:
        return next((e for e in self.entries if e.slug == slug), None)

    @property
    def slugs(self) -> set[str]:
        return {e.slug for e in self.entries}


def render_topics(tf: TopicsFile) -> str:
    entries = sorted(tf.entries, key=lambda e: e.last, reverse=True)[:MAX_TOPICS]
    lines = ["---", f"chat: {tf.chat_id}", f"through: {tf.through or 'none'}", f"current: {tf.current or 'none'}",
             f"updated: {tf.updated}", "---"]
    for e in entries:
        lines.append(f"- {e.slug} | {one_line(e.label, 80)} | {e.last} | {e.rounds} rounds | "
                     f"{one_line(e.keywords, 200)} | {one_line(e.gist, 200)}")
    return "\n".join(lines) + "\n"


def parse_topics(text: str) -> TopicsFile:
    meta, body = _front_matter(text or "")
    through = meta.get("through", "")
    current = meta.get("current", "")
    tf = TopicsFile(chat_id=meta.get("chat", ""), through="" if through in ("", "none") else through,
                    current="" if current in ("", "none") else current, updated=meta.get("updated", ""))
    for line in body.splitlines():
        if not line.startswith("- "):
            continue
        parts = [p.strip() for p in line[2:].split("|")]
        if len(parts) < 6:
            continue
        rounds = re.match(r"\d+", parts[3])
        tf.entries.append(TopicEntry(slug=parts[0], label=parts[1], last=parts[2],
                                     rounds=int(rounds.group()) if rounds else 0,
                                     keywords=parts[4], gist="|".join(parts[5:])))
    return tf


# {slug}.md


@dataclass
class Quote:
    message_id: str
    role: str  # writer | assistant
    date: str
    text: str


@dataclass
class Topic:
    label: str
    slug: str
    chat_id: str
    first: str = ""
    last: str = ""
    rounds: int = 0
    keywords: list[str] = field(default_factory=list)
    gist: str = ""
    recent: list[str] = field(default_factory=list)  # message ids, oldest first
    last_message: str = ""  # the newest message filed here: a rerun after a crash skips rounds up to it
    summary: str = ""
    verbatim: list[Quote] = field(default_factory=list)


def clean_summary(text: str, limit: int) -> str:
    """The summary sits under a `## Summary` heading, so a heading inside it would break the file's sections."""
    text = "\n".join(re.sub(r"^#+\s*", "", ln) for ln in (text or "").strip().splitlines())
    return squeeze(text, limit) if len(text) > limit else text


def render_topic(t: Topic) -> str:
    lines = ["---", f"topic: {one_line(t.label, 80)}", f"slug: {t.slug}", f"chat: {t.chat_id}", f"first: {t.first}",
             f"last: {t.last}", f"rounds: {t.rounds}", f"keywords: {', '.join(t.keywords)}",
             f"gist: {one_line(t.gist, 200)}", f"recent: {', '.join(t.recent)}", f"last_message: {t.last_message}",
             "---", "", "## Summary", "",
             t.summary.strip(), "", "## Verbatim", ""]
    for q in t.verbatim:
        lines.append(f"[{q.message_id} {q.role} {q.date}]")
        lines += [f"> {ln}" if ln else ">" for ln in q.text.splitlines()]
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def parse_topic(text: str) -> Topic | None:
    meta, body = _front_matter(text or "")
    if not meta.get("slug"):
        return None
    t = Topic(label=meta.get("topic", meta["slug"]), slug=meta["slug"], chat_id=meta.get("chat", ""),
              first=meta.get("first", ""), last=meta.get("last", ""),
              keywords=[k.strip() for k in meta.get("keywords", "").split(",") if k.strip()],
              gist=meta.get("gist", ""), recent=[r.strip() for r in meta.get("recent", "").split(",") if r.strip()],
              last_message=meta.get("last_message", ""))
    rounds = re.match(r"\d+", meta.get("rounds", ""))
    t.rounds = int(rounds.group()) if rounds else 0
    section, summary, current = "", [], None
    for line in body.splitlines():
        if line.startswith("## "):
            section = line[3:].strip().lower()
            current = None
            continue
        if section == "summary":
            summary.append(line)
        elif section == "verbatim":
            head = _VERBATIM_HEAD.match(line)
            if head:
                current = Quote(head.group(1), head.group(2), head.group(3), "")
                t.verbatim.append(current)
            elif current is not None and line.startswith(">"):
                current.text += ("\n" if current.text else "") + line[1:].removeprefix(" ")
    t.summary = "\n".join(summary).strip()
    return t


# INDEX.md (notebook level)


def index_line(chat_id: str, entry: TopicEntry) -> str:
    return (f"{entry.last} | {topic_path(chat_id, entry.slug)} | {one_line(entry.label, 80)} | "
            f"{one_line(entry.keywords, 200)} | {one_line(entry.gist, 200)}")


def render_index(per_chat: dict[str, list[TopicEntry]]) -> str:
    """Newest first, one line per topic. Rebuilt from every chat's TOPICS.md, never edited in place."""
    rows = [(e.last, index_line(chat, e)) for chat, entries in per_chat.items() for e in entries]
    return "\n".join(line for _, line in sorted(rows, key=lambda r: r[0], reverse=True)) + ("\n" if rows else "")
