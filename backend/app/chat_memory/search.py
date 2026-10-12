"""Ranked search over a notebook's chat memory: BM25, written in place.

grep finds exact strings but cannot rank and misses synonyms. Each topic file carries keywords with synonyms, and
every searchable unit (a saved quote or the summary) is scored together with its topic's label, gist and keywords, so
a search for "fee" can find a chat that only said "pricing". A notebook's chats are small, so this runs in
milliseconds from the files already on disk, with no index service."""

import math
import re
from collections import Counter
from dataclasses import dataclass

from app.chat_memory import files

K1 = 1.5
B = 0.75
MAX_RESULTS = 8
CUTOFF = 0.5  # drop results scoring under this share of the best one
SNIPPET_CHARS = 240

_WORD = re.compile(r"[a-z0-9]+")
_STOP = frozenset("a an and are as at be by for from has have i in is it its me my of on or that the this to was "
                  "we were what when which who with you your about did do does said say".split())


def tokenize(text: str) -> list[str]:
    out = []
    for w in _WORD.findall(text.lower()):
        if w in _STOP:
            continue
        out.append(w[:-1] if len(w) > 3 and w.endswith("s") and not w.endswith("ss") else w)
    return out


@dataclass
class Unit:
    path: str  # chat area relative: {chat}/{slug}.md
    line: int  # 1 based line in that file
    text: str  # what is shown
    topic: str
    last: str  # the topic's last active date
    tokens: list[str]


def units_for(path: str, text: str) -> list[Unit]:
    topic = files.parse_topic(text)
    if topic is None:
        return []
    lines = text.splitlines()
    context = tokenize(f"{topic.label} {topic.gist} {' '.join(topic.keywords)}")  # document expansion
    units: list[Unit] = []

    def add(line: int, shown: str) -> None:
        units.append(Unit(path, line, shown, topic.label, topic.last, tokenize(shown) + context))

    summary_line = next((i for i, ln in enumerate(lines, start=1) if ln.strip() == "## Summary"), 0)
    if topic.summary:
        add(summary_line + 2 if summary_line else 1, topic.summary)
    head = {q.message_id: 0 for q in topic.verbatim}
    for i, ln in enumerate(lines, start=1):
        for mid in head:
            if ln.startswith(f"[{mid} "):
                head[mid] = i
    for q in topic.verbatim:
        add(head[q.message_id] + 1 if head[q.message_id] else 1, q.text)
    return units


class Bm25:
    def __init__(self, units: list[Unit]):
        self.units = units
        self.tf = [Counter(u.tokens) for u in units]
        n = max(len(units), 1)
        self.avg = sum(len(u.tokens) for u in units) / n if units else 0.0
        df: Counter[str] = Counter()
        for c in self.tf:
            df.update(c.keys())
        self.idf = {t: math.log(1 + (n - d + 0.5) / (d + 0.5)) for t, d in df.items()}

    def search(self, query: str, since: str = "") -> list[tuple[float, Unit]]:
        terms = list(dict.fromkeys(tokenize(query)))
        scored = []
        for unit, tf in zip(self.units, self.tf, strict=True):
            if since and unit.last < since:
                continue
            length = len(unit.tokens) or 1
            score = 0.0
            for t in terms:
                f = tf.get(t, 0)
                if f:
                    score += self.idf[t] * f * (K1 + 1) / (f + K1 * (1 - B + B * length / (self.avg or 1)))
            if score > 0:
                scored.append((score, unit))
        scored.sort(key=lambda s: s[0], reverse=True)
        return scored


def cut(scored: list[tuple[float, Unit]]) -> list[tuple[float, Unit]]:
    """Keep the clear winners: results within CUTOFF of the best score, at most MAX_RESULTS, at least one."""
    if not scored:
        return []
    top = scored[0][0]
    return [s for s in scored if s[0] >= top * CUTOFF][:MAX_RESULTS]


_cache: dict[tuple, Bm25] = {}


def index_for(key: tuple, load_units) -> Bm25:
    """The BM25 index for one notebook, rebuilt only when its files change (the key holds the manifest hashes)."""
    if key not in _cache:
        if len(_cache) >= 8:
            _cache.pop(next(iter(_cache)))
        _cache[key] = Bm25(load_units())
    return _cache[key]
