"""A workspace's archive as a file system.

Every post is one markdown file. The research agent navigates it with list/search/read tools, the
same way a coding agent navigates a repo, so there is no vector index to build or keep in sync.

Layout (paths relative to the corpus root):

    INDEX.md                                       one line per post: date | path | title | headings
    sources/{source-slug}/{date}-{post-slug}.md    front matter + clean markdown

R2 is the source of truth (ws/{id}/corpus/...). Each process keeps a disk cache under
CORPUS_CACHE_DIR and syncs it from R2 through manifest.json (path -> sha256), so the API and worker
containers see the same files without sharing a volume.
"""

import hashlib
import json
import logging
import re
import threading
import time
import unicodedata
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path, PurePosixPath

from sqlalchemy import text as sql

from app.config import settings
from app.db import engine
from app.services.storage import is_not_found
from app.services.storage import storage as default_storage

log = logging.getLogger(__name__)

MANIFEST = "manifest.json"
INDEX = "INDEX.md"
MAX_READ_LINES = 160
MAX_READ_CHARS = 12_000  # one read() result: a "line" is a whole paragraph, so lines alone do not bound it
MAX_SEARCH_HITS = 40
MAX_LINE_CHARS = 240  # a search hit shows this much of its line, centred on the match
LONG_LINE_CHARS = 1_500  # a paragraph longer than this is stored as several lines (cut at sentence ends)
CARDS_DIR = "cards"  # post cards (app/pipeline/cards.py): cards/<post path>.json, never citable


def card_rel(post_rel: str) -> str:
    return f"{CARDS_DIR}/{post_rel}.json"


_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")


def split_long(paragraph: str, limit: int = LONG_LINE_CHARS) -> list[str]:
    """A long paragraph as several lines of at most about `limit` characters, cut at sentence ends, so a citation
    points at a few sentences instead of a whole page (PDFs and transcripts often have no paragraph breaks).
    Code blocks and anything already on several lines are kept as they are."""
    if len(paragraph) <= limit or "\n" in paragraph or paragraph.startswith("```"):
        return [paragraph]
    out, piece = [], ""
    for sentence in _SENTENCE_END.split(paragraph):
        if piece and len(piece) + len(sentence) + 1 > limit:
            out.append(piece)
            piece = ""
        piece = f"{piece} {sentence}" if piece else sentence
    if piece:
        out.append(piece)
    return out

_locks: dict[tuple[uuid.UUID, str], threading.Lock] = {}
# Posts only: when this process last brought a corpus in line with R2, and the manifest it saw (root -> (time, manifest)).
_synced: dict[str, tuple[float, dict[str, str]]] = {}


def slugify(text: str, max_len: int = 60) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    text = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    return text[:max_len].rstrip("-") or "untitled"


def post_path(source_slug: str, title: str, url: str, published_at: datetime | None) -> str:
    # Prefer the URL slug (stable across title edits), fall back to the title.
    tail = url.rstrip("/").rsplit("/", 1)[-1] if url else ""
    slug = slugify(tail if tail and not tail.startswith("?") else title)
    date = published_at.strftime("%Y-%m-%d") if published_at else "undated"
    return f"sources/{source_slug}/{date}-{slug}.md"


def render_post(*, title: str, url: str, published_at: datetime | None, source: str,
                sections: list[tuple[str | None, str]]) -> str:
    safe_title = title.replace('"', "'")
    lines = [
        "---",
        f'title: "{safe_title}"',
        f"url: {url}",
        f"published: {published_at.date().isoformat() if published_at else 'unknown'}",
        f"source: {source}",
        "---",
        "",
        f"# {title}",
        "",
    ]
    for heading, text in sections:
        if heading:
            lines += [f"## {heading}", ""]
        for para in text.split("\n\n"):
            lines += [*split_long(para.strip()), ""]  # the pieces stay one paragraph (no blank line between)
    return "\n".join(lines).rstrip() + "\n"


def index_line(path: str, title: str, published_at: datetime | None, headings: list[str]) -> str:
    date = published_at.strftime("%Y-%m-%d") if published_at else "undated"
    heads = "; ".join(h for h in headings if h)[:300]
    return f"{date} | {path} | {title}" + (f" | {heads}" if heads else "")


class CorpusError(ValueError):
    pass


@dataclass
class Hit:
    path: str
    line: int
    text: str


class Corpus:
    def __init__(self, workspace_id: uuid.UUID, store=None, cache_dir: str | None = None, area: str = "corpus"):
        """`area` picks the folder inside the workspace: "corpus" for posts, "chats/{notebook_id}" for chat memory.
        Each area has its own manifest, disk cache and lock."""
        self.workspace_id = workspace_id
        self.area = area.strip("/")
        self.store = store or default_storage
        base = Path(cache_dir or settings.corpus_cache_dir) / str(workspace_id)
        self.root = base if self.area == "corpus" else base / self.area
        self._lock = _locks.setdefault((workspace_id, self.area), threading.Lock())

    # Keys and paths

    def _key(self, rel: str) -> str:
        return f"ws/{self.workspace_id}/{self.area}/{rel}"

    @staticmethod
    def clean_rel(rel: str) -> str:
        rel = rel.strip().lstrip("/").replace("\\", "/")
        parts = PurePosixPath(rel).parts
        if not rel or any(p in ("..", "") for p in parts) or rel.startswith("."):
            raise CorpusError(f"Invalid path: {rel!r}")
        return str(PurePosixPath(*parts))

    def _local(self, rel: str) -> Path:
        return self.root / self.clean_rel(rel)

    # Manifest

    def _read_manifest(self, remote: bool) -> dict[str, str]:
        if remote:
            if not self.store.exists(self._key(MANIFEST)):
                return {}
            return json.loads(self.store.get_bytes(self._key(MANIFEST)))
        local = self.root / MANIFEST
        return json.loads(local.read_text("utf-8")) if local.exists() else {}

    def _write_manifest(self, manifest: dict[str, str]) -> None:
        data = json.dumps(manifest, sort_keys=True, indent=0)
        self.store.put_text(self._key(MANIFEST), data, "application/json")
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / MANIFEST).write_text(data, "utf-8")

    @contextmanager
    def _manifest_lock(self) -> Iterator[None]:
        """Serialise manifest read-modify-writes across processes. The API (deletes) and the worker (imports, cards,
        chat memory) both rewrite manifest.json; `self._lock` only covers one process, and without this a writer that
        read the manifest before another's delete wrote it back with the deleted files still listed. A Postgres
        transaction advisory lock (works through Neon's transaction pooler) keyed on workspace + area; released when
        the transaction ends. SQLite (tests, local dev) has one writer process anyway, so it is skipped there.
        Callers hold `self._lock` first."""
        if engine.dialect.name != "postgresql":
            yield
            return
        digest = hashlib.blake2b(f"corpus:{self.workspace_id}:{self.area}".encode(), digest_size=8).digest()
        with engine.begin() as conn:
            conn.execute(sql("SET LOCAL lock_timeout = '60s'"))
            conn.execute(sql("SELECT pg_advisory_xact_lock(:k)"), {"k": int.from_bytes(digest, "big", signed=True)})
            yield

    # Writes (worker)

    def write_files(self, files: dict[str, str], remove: set[str] | None = None) -> None:
        """Write/replace files and update the manifest once. Values are file contents.

        Objects are uploaded before the manifest lock is taken (a big import does not hold up a delete), then the
        manifest is re-read and updated under the lock. Removed objects are deleted after the manifest stops listing
        them, so a reader never sees a listed file that is already gone."""
        written: dict[str, str] = {}
        for rel, body in files.items():
            rel = self.clean_rel(rel)
            self.store.put_text(self._key(rel), body, "text/markdown; charset=utf-8")
            written[rel] = body
        with self._lock, self._manifest_lock():
            manifest = self._read_manifest(remote=True)
            for rel, body in written.items():
                local = self._local(rel)
                local.parent.mkdir(parents=True, exist_ok=True)
                local.write_text(body, "utf-8")
                manifest[rel] = hashlib.sha256(body.encode()).hexdigest()
            removing = {self.clean_rel(rel) for rel in remove or set()}
            if self.area == "corpus":  # a removed post takes its card with it
                removing |= {card_rel(rel) for rel in removing if card_rel(rel) in manifest}
            for rel in removing:
                manifest.pop(rel, None)
            self._write_manifest(manifest)
            for rel in removing:
                self.store.delete(self._key(rel))
                self._local(rel).unlink(missing_ok=True)
            if self.area == "corpus":
                _synced[str(self.root)] = (time.monotonic(), dict(manifest))

    def _drop_missing(self, missing: set[str]) -> dict[str, str]:
        """Take entries whose object is gone out of the remote manifest (left there by an older lost update, or a
        delete outside the app). Re-checked under the lock: an entry a writer has since fixed is kept."""
        with self._manifest_lock():
            manifest = self._read_manifest(remote=True)
            gone = {rel for rel in missing if rel in manifest and not self.store.exists(self._key(rel))}
            if gone:
                for rel in gone:
                    manifest.pop(rel)
                self.store.put_text(self._key(MANIFEST), json.dumps(manifest, sort_keys=True, indent=0),
                                    "application/json")
                log.warning("corpus %s/%s: dropped %d manifest entries with no object: %s",
                            self.workspace_id, self.area, len(gone), sorted(gone))
            return manifest

    # Sync (API / any reader)

    def sync(self, need: tuple[str, ...] | list[str] = ()) -> dict[str, str]:
        """Bring the disk cache in line with R2. Downloads only files whose hash changed.

        Posts: a sync within CORPUS_SYNC_TTL_SECONDS of the last one in this process is skipped, unless a path in
        `need` is missing from what that sync saw (a post added since). Chat memory always syncs."""
        ttl = settings.corpus_sync_ttl_seconds if self.area == "corpus" else 0
        seen = _synced.get(str(self.root))
        if ttl > 0 and seen and time.monotonic() - seen[0] < ttl and all(p in seen[1] for p in need):
            return seen[1]
        with self._lock:
            remote = self._read_manifest(remote=True)
            local = self._read_manifest(remote=False)
            missing: set[str] = set()
            for rel, digest in remote.items():
                path = self._local(rel)
                if local.get(rel) == digest and path.exists():
                    continue
                try:
                    data = self.store.get_bytes(self._key(rel))
                except Exception as exc:
                    if not is_not_found(exc):
                        raise
                    missing.add(rel)  # one listed-but-gone file must not fail every read in the workspace
                    continue
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
            if missing:
                self._drop_missing(missing)
                # Not on disk now: leave them out of the local manifest so a later sync fetches any a writer restored.
                remote = {rel: digest for rel, digest in remote.items() if rel not in missing}
            for rel in set(local) - set(remote):
                self._local(rel).unlink(missing_ok=True)
            self.root.mkdir(parents=True, exist_ok=True)
            (self.root / MANIFEST).write_text(json.dumps(remote, sort_keys=True, indent=0), "utf-8")
            if self.area == "corpus":
                _synced[str(self.root)] = (time.monotonic(), remote)
            return remote

    # Reads

    def exists(self, rel: str) -> bool:
        return self._local(rel).is_file()

    def read_lines(self, rel: str) -> list[str]:
        path = self._local(rel)
        if not path.is_file():
            raise CorpusError(f"No such file: {rel}")
        return path.read_text("utf-8").splitlines()


def _snippet(line: str, match: re.Match) -> str:
    """MAX_LINE_CHARS of the line around the match: a line can be a long paragraph whose match is far from its start."""
    line = line.strip() if len(line) <= MAX_LINE_CHARS else line
    if len(line) <= MAX_LINE_CHARS:
        return line
    start = max(0, min(match.start() - MAX_LINE_CHARS // 3, len(line) - MAX_LINE_CHARS))
    text = line[start:start + MAX_LINE_CHARS].strip()
    return ("..." if start > 0 else "") + text + ("..." if start + MAX_LINE_CHARS < len(line) else "")


class ScopedTools:
    """The agent's tools, restricted to an allowlist of files (a notebook's posts).

    Every call is logged so the UI can stream "Searching..." / "Reading..." steps and so we can
    verify citations only point at files the agent actually opened or matched.
    """

    def __init__(self, corpus: Corpus, allowed: dict[str, str], on_step=None):
        # allowed: path -> title
        self.corpus = corpus
        self.allowed = allowed
        self.on_step = on_step or (lambda kind, detail: None)

    def _check(self, rel: str) -> str:
        rel = Corpus.clean_rel(rel)
        if rel != INDEX and rel not in self.allowed:
            raise CorpusError(f"{rel} is not in this notebook. Use list_files to see what is.")
        return rel

    def list_files(self, contains: str = "") -> str:
        """List the posts in this notebook, one per line as `date | path | title`, newest first.
        Optionally filter to lines containing `contains` (case insensitive)."""
        self.on_step("list", contains or "all posts")
        index = {}
        if self.corpus.exists(INDEX):
            for line in self.corpus.read_lines(INDEX):
                parts = [p.strip() for p in line.split("|")]
                if len(parts) >= 3 and parts[1] in self.allowed:
                    index[parts[1]] = line
        rows = [index.get(p, f"undated | {p} | {t}") for p, t in self.allowed.items()]
        if contains:
            rows = [r for r in rows if contains.lower() in r.lower()]
        rows.sort(reverse=True)
        return "\n".join(rows[:300]) or "No matching posts."

    def search(self, pattern: str, path: str = "") -> str:
        """Search post text with a case insensitive regular expression (like grep). Use `|` for
        alternatives, e.g. `pric(e|ing)|paid tier|subscription cost`. Optionally limit to one `path`.
        Returns `path:line: text` matches, the posts with the most matches first."""
        self.on_step("search", pattern)
        try:
            rx = re.compile(pattern, re.IGNORECASE)
        except re.error:
            rx = re.compile(re.escape(pattern), re.IGNORECASE)
        targets = [self._check(path)] if path else list(self.allowed)
        by_post: dict[str, list[tuple[int, int, Hit]]] = {}  # path -> (matches on the line, line, hit)
        unavailable = 0
        for rel in targets:
            try:
                lines = self.corpus.read_lines(rel)
            except CorpusError:  # one missing file must not fail the search over every other post
                unavailable += 1
                continue
            for n, line in enumerate(lines, start=1):
                found = list(rx.finditer(line))
                if found:
                    by_post.setdefault(rel, []).append((len(found), n, Hit(rel, n, _snippet(line, found[0]))))
        total = sum(len(v) for v in by_post.values())
        note = f"\n({unavailable} post(s) could not be read right now)" if unavailable else ""
        if not total:
            return "No matches. Try synonyms or a broader pattern." + note
        # Posts with more matching lines first (a post about the subject beats one that mentions it), lines in order.
        ranked = sorted(by_post.values(), key=lambda v: (-len(v), -sum(m for m, _, _ in v)))
        hits = [h for post in ranked for _, _, h in post][:MAX_SEARCH_HITS]
        out = "\n".join(f"{h.path}:{h.line}: {h.text}" for h in hits)
        if total > len(hits):
            out += f"\n... {total - len(hits)} more matches. Narrow the pattern or pass a path."
        return out + note

    def read(self, path: str, start_line: int = 1, end_line: int = 0) -> str:
        """Read a post with line numbers. Reads at most 160 lines per call; pass start_line and
        end_line to page through long posts. Cite answers with these line numbers."""
        rel = self._check(path)
        lines = self.corpus.read_lines(rel)
        start = max(1, start_line)
        end = min(len(lines), end_line if end_line >= start else start + MAX_READ_LINES - 1)
        end = min(end, start + MAX_READ_LINES - 1)
        rows, used = [], 0
        for n in range(start, end + 1):
            row = f"{n}| {lines[n - 1]}"
            if rows and used + len(row) > MAX_READ_CHARS:  # stop before the result gets too big; page on from here
                end = n - 1
                break
            rows.append(row[:MAX_READ_CHARS])
            used += len(row) + 1
        self.on_step("read", f"{self.allowed.get(rel, rel)} (lines {start} to {end})")
        body = "\n".join(rows)
        more = f"\n[{len(lines) - end} more lines]" if end < len(lines) else ""
        return f"{rel} ({len(lines)} lines)\n{body}{more}"

    def quote(self, rel: str, start: int, end: int) -> str | None:
        """Text of a cited line range, or None if the citation does not point at real content."""
        try:
            rel = self._check(rel)
            lines = self.corpus.read_lines(rel)
        except CorpusError:
            return None
        if start < 1 or start > len(lines):
            return None
        end = max(start, min(end, len(lines), start + 40))
        text = "\n".join(lines[start - 1 : end]).strip()
        return text or None
