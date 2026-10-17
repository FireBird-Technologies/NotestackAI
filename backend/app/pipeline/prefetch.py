"""Evidence before the agent starts: a BM25 search over the notebook's posts, cut into passages that follow the posts'
sections.

The agent's first steps are nearly always list_files, search, read, each one a model call. Handing it the best
passages up front lets it cite them directly or go straight to the right post, and when they clearly cover a quick
question the answer is written from them in one call (the fast path in research.py). Same ranking as chat memory
search (app/chat_memory/search.py), built from the files already on disk, no index service."""

import hashlib
import re
from dataclasses import dataclass, field

from app.chat_memory.search import Bm25, tokenize
from app.corpus import Corpus, CorpusError
from app.pipeline.passages import _body_start

# Passages follow the post's sections and are sized by characters, not lines: a line here is anything from a heading
# to a 3,800 character paragraph. Measured on real notebooks, the median section is about 1,100 characters.
SECTION_KEEP_CHARS = 2_000  # a section up to this size is one passage, however many lines it has
BLOCK_CHARS = 1_200  # a longer section is cut at paragraph breaks into passages of about this size
TAIL_CHARS = 300  # a leftover this small joins the passage before it; a section this small joins the next one
CONTEXT_BUDGET_CHARS = 12_000  # the passages handed over, with the rest of their sections added, stay under this
SECTION_WHOLE_CHARS = 6_000  # a matching section up to this size is sent whole; a longer one, the match and its neighbours
BLOCKS_VERSION = 2  # in the index cache key: a change to how passages are cut never reuses an old index
TOP_K = 6
PER_POST = 2  # at most this many passages from one post, so a long post cannot crowd out the others
DEEP_TOP_K = 10  # a synthesis question gets more evidence
DEEP_PER_POST = 3
OVERVIEW_BUDGET_CHARS = 24_000  # opening passages for a question about the whole notebook
OVERVIEW_LIST_CHARS = 12_000  # the post list given with them
# Words that say what kind of question it is, not what it is about. They would make coverage look worse than it is.
_QUESTION_WORDS = frozenset("written write wrote writing think thought post blog article tell explain mean view take "
                            "opinion summarize summarise summary talk talked mention mentioned any ever how why often "
                            "much many where who whom whose can could would should will just really also mine myself "
                            "give show list find".split())
# Words of a question about the whole notebook rather than one subject ("the strongest ideas across these posts").
# A question made only of these has no subject to search for: it gets the overview instead.
_GENERIC = frozenset("strongest strong best main key biggest important interesting ideas idea themes theme topics "
                     "topic across overall general common recurring archive notebook these those all everything most "
                     "brief intro introduction short quick detail detailed overview".split())
# Words too vague to say what the question is about. Left in, they lower coverage without finding anything.
_WEAK = frozenset("into help use using used make made get got thing way lot really very also".split())
_HEADING = re.compile(r"^#{2,6}\s")
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")


def _stem(word: str) -> str:
    """A light suffix stemmer, so "pricing", "priced" and "prices" all find "price". Questions and passages go through
    the same steps, so what matters is that related forms meet, not that the stems are real words."""
    if len(word) <= 3:
        return word
    if word.endswith("ies") and len(word) > 5:
        word = word[:-3] + "y"
    for suffix in ("ing", "ed", "ly"):
        if word.endswith(suffix) and len(word) - len(suffix) >= 3:
            word = word[:-len(suffix)]
            break
    if word.endswith("e") and len(word) > 3:
        word = word[:-1]
    if len(word) > 3 and word[-1] == word[-2] and word[-1] not in "aeiouls":  # runn -> run, but keep "all", "class"
        word = word[:-1]
    return word


def _terms(text: str) -> list[str]:
    return [_stem(t) for t in tokenize(text)]


@dataclass
class Passage:
    path: str
    start: int
    end: int
    title: str
    lines: list[str]  # the text of lines start..end
    tokens: list[str]
    last: str = ""  # Bm25 filters on it; posts are never filtered by date here
    heading: str = ""  # the section it belongs to, "" before the first heading
    next: "Passage | None" = field(default=None, repr=False, compare=False)  # the following passage in the section
    section: list["Passage"] = field(default_factory=list, repr=False, compare=False)  # every passage of its section

    def render(self) -> str:
        return _render([self])


def _render(run: list["Passage"]) -> str:
    """One passage, or neighbours from the same post joined into one, with the real line numbers. Pieces of one long
    line (cut at sentence ends) are put back together on that line."""
    text: dict[int, str] = {}
    for p in run:
        for n, line in enumerate(p.lines, start=p.start):
            text[n] = f"{text[n]} {line}" if n in text and text[n] != line else line
    first, last = min(text), max(text)
    headings = list(dict.fromkeys(p.heading for p in run if p.heading))
    label = " › ".join([run[0].title, " / ".join(headings)]) if headings else run[0].title
    body = "\n".join(f"{n}| {text[n]}" for n in range(first, last + 1) if n in text)
    return f"{run[0].path} lines {first}-{last} ({label})\n{body}"


@dataclass
class Prefetch:
    passages: list[tuple[float, Passage]] = field(default_factory=list)
    coverage: float = 0.0  # share of the question's content words found in the passages
    terms: list[str] = field(default_factory=list)  # content words that occur somewhere in the notebook
    asked: list[str] = field(default_factory=list)  # every content word of the question, typos included
    for_coverage: int = 0  # passages picked because they hold a word the higher-scoring ones lacked
    added: list[Passage] = field(default_factory=list)  # the rest of each picked passage's section, so a topic's
    # details come with the lines that matched

    @property
    def overview(self) -> bool:
        """No subject to search for: a question about the notebook as a whole, or words found in no post."""
        return not self.terms

    @property
    def text(self) -> str:
        """Picked and added passages, grouped by post (best-scoring post first) and joined where their lines touch."""
        if not self.passages:
            return "(nothing found by keyword search)"
        groups: dict[str, list[Passage]] = {}
        for p in [p for _, p in self.passages] + self.added:
            groups.setdefault(p.path, []).append(p)
        out = []
        for ps in groups.values():
            ps.sort(key=lambda p: (p.start, p.end))
            run = [ps[0]]
            for p in ps[1:]:
                if p.start <= max(q.end for q in run) + 1:
                    run.append(p)
                else:
                    out.append(_render(run))
                    run = [p]
            out.append(_render(run))
        return "\n\n".join(out)

    @property
    def top_score(self) -> float:
        return self.passages[0][0] if self.passages else 0.0


Line = tuple[int, str]  # (1-based line number, text)


def _size(lines: list[Line]) -> int:
    return sum(len(t) for _, t in lines)


def _sections(lines: list[str], start: int) -> list[tuple[str, list[Line]]]:
    """The post body cut at its headings. Text before the first heading is a section of its own; a section too small
    to stand alone (a heading and a line) joins the next one, keeping both headings."""
    sections: list[tuple[str, list[Line]]] = []
    heading, cur = "", []
    for i in range(start, len(lines)):
        if _HEADING.match(lines[i]):
            if any(t.strip() for _, t in cur):
                sections.append((heading, cur))
            heading, cur = lines[i].lstrip("#").strip(), []
        cur.append((i + 1, lines[i]))
    if any(t.strip() for _, t in cur):
        sections.append((heading, cur))
    merged: list[tuple[str, list[Line]]] = []
    carry: tuple[str, list[Line]] | None = None
    for i, (heading, body) in enumerate(sections):
        if carry is not None:
            heading = " / ".join(h for h in (carry[0], heading) if h)
            body = carry[1] + body
            carry = None
        if _size(body) < TAIL_CHARS and i < len(sections) - 1:
            carry = (heading, body)
            continue
        merged.append((heading, body))
    if carry is not None:
        merged.append(carry)
    return merged


def _units(body: list[Line]) -> list[list[Line]]:
    """Paragraphs (runs of non-blank lines, blank lines kept with the paragraph before). A paragraph over
    SECTION_KEEP_CHARS is cut: across its lines, and a single huge line at sentence ends (each piece keeps the line's
    number, so a citation still points at a real line)."""
    paragraphs: list[list[Line]] = []
    for n, t in body:
        if t.strip() and (not paragraphs or not paragraphs[-1][-1][1].strip()):
            paragraphs.append([])
        if not paragraphs:
            paragraphs.append([])
        paragraphs[-1].append((n, t))
    units: list[list[Line]] = []
    for para in paragraphs:
        if _size(para) <= SECTION_KEEP_CHARS:
            units.append(para)
            continue
        for n, t in para:
            if len(t) <= BLOCK_CHARS:
                units.append([(n, t)])
                continue
            piece = ""
            for sentence in _SENTENCE_END.split(t):
                if piece and len(piece) + len(sentence) + 1 > BLOCK_CHARS:
                    units.append([(n, piece)])
                    piece = ""
                piece = f"{piece} {sentence}" if piece else sentence
            if piece:
                units.append([(n, piece)])
    return units


def _blocks(body: list[Line]) -> list[list[Line]]:
    """A section up to SECTION_KEEP_CHARS stays whole. A longer one is packed paragraph by paragraph into blocks of
    about BLOCK_CHARS; a small leftover joins the block before it."""
    if _size(body) <= SECTION_KEEP_CHARS:
        return [body]
    blocks: list[list[Line]] = []
    for unit in _units(body):
        if blocks and _size(blocks[-1]) + _size(unit) <= BLOCK_CHARS:
            blocks[-1].extend(unit)
        else:
            blocks.append(list(unit))
    if len(blocks) > 1 and _size(blocks[-1]) < TAIL_CHARS:
        blocks[-2].extend(blocks.pop())
    return blocks


def _passage(rel: str, title: str, heading: str, block: list[Line]) -> Passage:
    text: dict[int, str] = {}
    for n, t in block:  # pieces of one long line become that line again
        text[n] = f"{text[n]} {t}" if n in text else t
    first, last = min(text), max(text)
    lines = [text.get(n, "") for n in range(first, last + 1)]
    # The title and the heading on every passage: the details under "## Getting featured" are about getting featured
    # even when their own lines never say so.
    tokens = _terms(" ".join(t for _, t in block)) + _terms(title) + _terms(heading)
    return Passage(rel, first, last, title, lines, tokens, heading=heading)


def passages_of(corpus: Corpus, rel: str, title: str) -> list[Passage]:
    try:
        lines = corpus.read_lines(rel)
    except CorpusError:
        return []
    out: list[Passage] = []
    for heading, body in _sections(lines, _body_start(lines)):
        section = [_passage(rel, title, heading, b) for b in _blocks(body) if any(t.strip() for _, t in b)]
        for a, b in zip(section, section[1:], strict=False):
            a.next = b  # only within the section: the next section is another topic
        for a in section:
            a.section = section
        out.extend(section)
    return out


class _PostIndex(Bm25):
    """BM25 over post passages, whose tokens are stemmed: a query is stemmed the same way before it is scored."""

    def search(self, query: str, since: str = "") -> list[tuple[float, Passage]]:
        return self.search_terms(list(dict.fromkeys(_terms(query))), since)


_cache: dict[str, _PostIndex] = {}


def _index(corpus: Corpus, allowed: dict[str, str], manifest: dict[str, str]) -> _PostIndex:
    """One index per notebook and file version: rebuilt only when a post in it changes."""
    sig = "\n".join(f"{p}\t{manifest.get(p, '')}" for p in sorted(allowed))
    key = hashlib.sha1(f"v{BLOCKS_VERSION}\n{corpus.root}\n{sig}".encode()).hexdigest()
    if key not in _cache:
        if len(_cache) >= 16:
            _cache.pop(next(iter(_cache)))
        _cache[key] = _PostIndex([p for rel, title in allowed.items() for p in passages_of(corpus, rel, title)])
    return _cache[key]


def prefetch(corpus: Corpus, allowed: dict[str, str], manifest: dict[str, str], question: str,
             k: int = TOP_K, per_post_max: int = PER_POST) -> Prefetch:
    words = [t for t in tokenize(question) if t not in _QUESTION_WORDS and t not in _GENERIC and t not in _WEAK]
    asked = list(dict.fromkeys(_stem(t) for t in words))
    if not asked or not allowed:
        return Prefetch(asked=asked)
    index = _index(corpus, allowed, manifest)
    # A word that occurs in no post (a typo like "waht", or a word the writer never used) cannot be found, so it
    # neither counts against coverage nor is searched for.
    terms = [t for t in asked if t in index.idf]
    if not terms:
        return Prefetch(asked=asked)
    ranked = index.search_terms(terms)
    picked = _pick(ranked, terms, k, per_post_max)
    added = _sections_of(picked)
    found = set().union(*(p.tokens for p in [p for _, p in picked] + added)) if picked else set()
    by_score = {id(p) for _, p in _pick(ranked, [], k, per_post_max)}  # what score order alone would have picked
    return Prefetch(picked, sum(t in found for t in terms) / len(terms), terms, asked,
                    sum(id(p) not in by_score for _, p in picked), added)


def _sections_of(picked: list[tuple[float, Passage]]) -> list[Passage]:
    """The rest of each picked passage's section, best-scoring first, while the whole stays under CONTEXT_BUDGET_CHARS.
    A topic's keywords are often in its opening lines and its details in the lines after, so a matching section up to
    SECTION_WHOLE_CHARS is sent whole. A longer one, or one that no longer fits, sends the passages on either side of
    the match instead (the next one first), so one 20,000 character section cannot take the room other posts need."""
    seen = {id(p) for _, p in picked}
    used = sum(len(p.render()) for _, p in picked)
    added: list[Passage] = []

    def add(passages: list[Passage]) -> bool:
        nonlocal used
        new = [q for q in passages if id(q) not in seen]
        size = sum(len(q.render()) for q in new)
        if not new or used + size > CONTEXT_BUDGET_CHARS:
            return False
        added.extend(new)
        seen.update(id(q) for q in new)
        used += size
        return True

    for _, p in picked:
        section = p.section or [p]
        if len(section) < 2:
            continue
        if sum(len(q.render()) for q in section) <= SECTION_WHOLE_CHARS and add(section):
            continue
        at = next(i for i, q in enumerate(section) if q is p)
        after = section[at + 1:at + 2]
        before = section[max(0, at - 1):at]
        if not add(after + before):
            add(after) or add(before)
    return added


def _pick(ranked: list[tuple[float, Passage]], terms: list[str], k: int,
          per_post_max: int) -> list[tuple[float, Passage]]:
    """The k passages to hand over, so that together they cover the question.

    Ranking passages one by one lets a rare word crowd out the rest: for "pricing and hiring after BlogHub" every top
    passage can be about BlogHub, and hiring never makes the cut. So, after the best passage overall, each word still
    missing gets the best passage that holds it, and only then do the remaining slots go by score. The per-post limit
    keeps one long post from filling the slots; it gives way only when the one passage holding a word is over it."""
    picked: list[tuple[float, Passage]] = []
    taken: set[int] = set()
    per_post: dict[str, int] = {}
    covered: set[str] = set()

    def take(entry: tuple[float, Passage]) -> None:
        picked.append(entry)
        taken.add(id(entry[1]))
        per_post[entry[1].path] = per_post.get(entry[1].path, 0) + 1
        covered.update(t for t in terms if t in entry[1].tokens)

    def room(p: Passage) -> bool:
        return id(p) not in taken and per_post.get(p.path, 0) < per_post_max

    if ranked:
        take(ranked[0])
    for term in terms:  # 1. every word of the question in at least one passage
        if len(picked) >= k:
            break
        if term in covered:
            continue
        holding = [e for e in ranked if term in e[1].tokens and id(e[1]) not in taken]
        best = next((e for e in holding if room(e[1])), holding[0] if holding else None)
        if best is not None:
            take(best)
    for entry in ranked:  # 2. the remaining slots by score
        if len(picked) >= k:
            break
        if room(entry[1]):
            take(entry)
    picked.sort(key=lambda e: e[0], reverse=True)
    return picked


def openings(corpus: Corpus, posts: list[tuple[str, str]], budget: int = OVERVIEW_BUDGET_CHARS) -> str:
    """The first passage of each post, in the order given (newest first), until the budget is used: what a question
    about the whole notebook is answered from."""
    out, used = [], 0
    for rel, title in posts:
        first = passages_of(corpus, rel, title)[:1]
        if not first:
            continue
        text = first[0].render()
        if used + len(text) > budget:
            break
        out.append(text)
        used += len(text)
    return "\n\n".join(out)
