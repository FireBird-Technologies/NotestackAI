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
import re
import threading
import unicodedata
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path, PurePosixPath

from app.config import settings
from app.services.storage import storage as default_storage

MANIFEST = "manifest.json"
INDEX = "INDEX.md"
MAX_READ_LINES = 160
MAX_SEARCH_HITS = 40
MAX_LINE_CHARS = 240

_locks: dict[uuid.UUID, threading.Lock] = {}


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
            lines += [para.strip(), ""]
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
    def __init__(self, workspace_id: uuid.UUID, store=None, cache_dir: str | None = None):
        self.workspace_id = workspace_id
        self.store = store or default_storage
        self.root = Path(cache_dir or settings.corpus_cache_dir) / str(workspace_id)
        self._lock = _locks.setdefault(workspace_id, threading.Lock())

    # Keys and paths

    def _key(self, rel: str) -> str:
        return f"ws/{self.workspace_id}/corpus/{rel}"

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

    # Writes (worker)

    def write_files(self, files: dict[str, str], remove: set[str] | None = None) -> None:
        """Write/replace files and update the manifest once. Values are file contents."""
        with self._lock:
            manifest = self._read_manifest(remote=True)
            for rel, text in files.items():
                rel = self.clean_rel(rel)
                self.store.put_text(self._key(rel), text, "text/markdown; charset=utf-8")
                local = self._local(rel)
                local.parent.mkdir(parents=True, exist_ok=True)
                local.write_text(text, "utf-8")
                manifest[rel] = hashlib.sha256(text.encode()).hexdigest()
            for rel in remove or set():
                rel = self.clean_rel(rel)
                manifest.pop(rel, None)
                self.store.delete(self._key(rel))
                self._local(rel).unlink(missing_ok=True)
            self._write_manifest(manifest)

    # Sync (API / any reader)

    def sync(self) -> dict[str, str]:
        """Bring the disk cache in line with R2. Downloads only files whose hash changed."""
        with self._lock:
            remote = self._read_manifest(remote=True)
            local = self._read_manifest(remote=False)
            for rel, digest in remote.items():
                path = self._local(rel)
                if local.get(rel) == digest and path.exists():
                    continue
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(self.store.get_bytes(self._key(rel)))
            for rel in set(local) - set(remote):
                self._local(rel).unlink(missing_ok=True)
            self.root.mkdir(parents=True, exist_ok=True)
            (self.root / MANIFEST).write_text(json.dumps(remote, sort_keys=True, indent=0), "utf-8")
            return remote

    # Reads

    def exists(self, rel: str) -> bool:
        return self._local(rel).is_file()

    def read_lines(self, rel: str) -> list[str]:
        path = self._local(rel)
        if not path.is_file():
            raise CorpusError(f"No such file: {rel}")
        return path.read_text("utf-8").splitlines()


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
        Returns `path:line: text` matches."""
        self.on_step("search", pattern)
        try:
            rx = re.compile(pattern, re.IGNORECASE)
        except re.error:
            rx = re.compile(re.escape(pattern), re.IGNORECASE)
        targets = [self._check(path)] if path else list(self.allowed)
        hits: list[Hit] = []
        total = 0
        for rel in targets:
            for n, line in enumerate(self.corpus.read_lines(rel), start=1):
                if rx.search(line):
                    total += 1
                    if len(hits) < MAX_SEARCH_HITS:
                        hits.append(Hit(rel, n, line.strip()[:MAX_LINE_CHARS]))
        if not hits:
            return "No matches. Try synonyms or a broader pattern."
        out = "\n".join(f"{h.path}:{h.line}: {h.text}" for h in hits)
        if total > len(hits):
            out += f"\n... {total - len(hits)} more matches. Narrow the pattern or pass a path."
        return out

    def read(self, path: str, start_line: int = 1, end_line: int = 0) -> str:
        """Read a post with line numbers. Reads at most 160 lines per call; pass start_line and
        end_line to page through long posts. Cite answers with these line numbers."""
        rel = self._check(path)
        lines = self.corpus.read_lines(rel)
        start = max(1, start_line)
        end = min(len(lines), end_line if end_line >= start else start + MAX_READ_LINES - 1)
        end = min(end, start + MAX_READ_LINES - 1)
        self.on_step("read", f"{self.allowed.get(rel, rel)} (lines {start} to {end})")
        body = "\n".join(f"{n}| {lines[n - 1]}" for n in range(start, end + 1))
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
