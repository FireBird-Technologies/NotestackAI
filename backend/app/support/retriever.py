"""BM25 over the help corpus: two indexes (title, keywords, headings and questions weigh 1.0; body 0.4) plus
context boosts for the page the writer is on and the docs the bot cited last turn."""

import re
from collections.abc import Iterable
from dataclasses import dataclass
from difflib import get_close_matches

from rank_bm25 import BM25Okapi

from app.support.corpus import Doc, get_corpus

_STOPWORDS = frozenset(
    """the a an and or but if then else of for to in on at by with from as is are was were be been being have has had
    do does did can could should would may might will shall must you he she it we they them us our your their my me him
    her this that these those there here what which who whom whose how why when where not no yes so up down out about
    into over under again just very more most some any all each other than too""".split()
)
_TOKEN = re.compile(r"[a-z0-9]+")
_SUFFIXES = ("ingly", "edly", "ing", "ies", "ied", "ed", "es", "s", "ly")

HIGH_WEIGHT = 1.0
BODY_WEIGHT = 0.4
HISTORY_WEIGHT = 0.5
ROUTE_BOOST = 3.0
CONTINUITY_BOOST = 2.0


def tokenize(text: str) -> list[str]:
    out: list[str] = []
    for tok in _TOKEN.findall((text or "").lower()):
        if len(tok) < 3 or tok in _STOPWORDS:
            continue
        for suf in _SUFFIXES:  # light stemming: syncing/synced/syncs -> sync
            if len(tok) > len(suf) + 2 and tok.endswith(suf):
                tok = tok[: -len(suf)]
                break
        out.append(tok)
    return out


@dataclass
class Scored:
    doc: Doc
    score: float
    breakdown: dict[str, float]


class Retriever:
    def __init__(self, docs: list[Doc]):
        self.docs = docs
        high = [tokenize(d.high_signal_text) or [d.id] for d in docs]
        body = [tokenize(d.body) or high[i] for i, d in enumerate(docs)]
        self._vocabulary = frozenset(tok for row in (*high, *body) for tok in row)
        self._high = BM25Okapi(high)
        self._body = BM25Okapi(body)

    def _query_tokens(self, text: str) -> list[str]:
        """Correct obvious long-token typos against the small, product-specific help vocabulary."""
        out = []
        for tok in tokenize(text):
            if tok not in self._vocabulary and len(tok) >= 5:
                match = get_close_matches(tok, self._vocabulary, n=1, cutoff=0.84)
                tok = match[0] if match else tok
            out.append(tok)
        return out

    def _scores(self, index: BM25Okapi, weighted: list[tuple[str, float]]) -> list[float]:
        total = [0.0] * len(self.docs)
        buckets: dict[float, list[str]] = {}
        for tok, w in weighted:  # rank-bm25 has no per-token weights, so score each weight bucket and sum
            buckets.setdefault(w, []).append(tok)
        for w, toks in buckets.items():
            for i, s in enumerate(index.get_scores(toks)):
                total[i] += w * float(s)
        return total

    def retrieve(
        self,
        query: str,
        *,
        history: Iterable[str] = (),
        page_path: str | None = None,
        last_cited: Iterable[str] = (),
        top_k: int = 3,
        min_score: float = 0.5,
    ) -> list[Scored]:
        weighted = [(t, 1.0) for t in self._query_tokens(query)]
        for prior in list(history)[-2:]:  # short follow ups ("and on the free plan?") borrow earlier words
            weighted += [(t, HISTORY_WEIGHT) for t in self._query_tokens(prior)]
        if not weighted:
            return []
        high, body = self._scores(self._high, weighted), self._scores(self._body, weighted)
        cited = set(last_cited)
        scored = []
        for i, doc in enumerate(self.docs):
            parts = {
                "high": HIGH_WEIGHT * high[i],
                "body": BODY_WEIGHT * body[i],
                "route": ROUTE_BOOST if page_path and (page_path == doc.route or page_path in doc.related_paths) else 0.0,
                "continuity": CONTINUITY_BOOST if doc.id in cited else 0.0,
            }
            scored.append(Scored(doc, sum(parts.values()), {k: round(v, 3) for k, v in parts.items()}))
        scored.sort(key=lambda s: s.score, reverse=True)
        return [s for s in scored[:top_k] if s.score >= min_score]


_default: Retriever | None = None


def get_retriever() -> Retriever:
    global _default
    if _default is None:
        _default = Retriever(get_corpus())
    return _default
