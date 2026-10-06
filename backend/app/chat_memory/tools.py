"""The agent's tools for earlier chats, scoped to one notebook's chat memory.

Paths are shown as `chats/{chat_id}/{topic}.md` so a citation tells a chat file from a post (`sources/...`). Only
topic files can be searched or read: the corpus root is the notebook's own area, and `clean_rel` rejects anything that
climbs out of it."""

import re

from app.chat_memory import files, search
from app.corpus import MAX_LINE_CHARS, MAX_READ_LINES, MAX_SEARCH_HITS, Corpus, CorpusError

PREFIX = "chats/"


def is_chat_path(path: str) -> bool:
    return path.strip().lstrip("/").startswith(PREFIX)


class ChatTools:
    def __init__(self, corpus: Corpus, on_step=None):
        self.corpus = corpus
        self.on_step = on_step or (lambda kind, detail: None)

    # Paths

    def _rel(self, path: str) -> str:
        rel = Corpus.clean_rel(path)
        rel = rel.removeprefix(PREFIX)
        name = rel.rsplit("/", 1)[-1]
        if not rel.endswith(".md") or name in (files.TOPICS, files.INDEX):
            raise CorpusError(f"{path} is not an earlier chat topic. Use list_chat_topics to see them.")
        if not self.corpus.exists(rel):
            raise CorpusError(f"No such earlier chat topic: {path}. Use list_chat_topics to see them.")
        return rel

    def topic_files(self) -> list[str]:
        manifest = self.corpus._read_manifest(remote=False)
        skip = (files.TOPICS, files.INDEX)
        return sorted(r for r in manifest if "/" in r and r.endswith(".md") and r.rsplit("/", 1)[-1] not in skip)

    @staticmethod
    def shown(rel: str) -> str:
        return PREFIX + rel

    # Tools

    def list_chat_topics(self, contains: str = "", since: str = "") -> str:
        """List the topics of earlier chats in this notebook, newest first, one per line as
        `date | path | topic | keywords | gist`. Filter to lines containing `contains` (case insensitive) and to
        topics last active on or after `since` (a date like 2026-09-24)."""
        self.on_step("recall", f"topics of earlier chats{f' about {contains}' if contains else ''}")
        if not self.corpus.exists(files.INDEX):
            return "No earlier chat topics yet."
        rows = []
        for line in self.corpus.read_lines(files.INDEX):
            parts = [p.strip() for p in line.split("|")]
            if len(parts) < 3:
                continue
            if since and parts[0] < since:
                continue
            if contains and contains.lower() not in line.lower():
                continue
            rows.append(" | ".join([parts[0], self.shown(parts[1]), *parts[2:]]))
        return "\n".join(rows[:60]) or "No matching topics."

    def search_chats(self, query: str, since: str = "", exact: bool = False) -> str:
        """Ranked search of earlier chats in this notebook (best matches first). Matches the words used and
        the topic's keywords, so a related word can find a chat that used another word. Optionally only topics last
        active on or after `since` (a date like 2026-09-24). Set exact=true to match `query` as a regular expression
        instead, for a literal phrase or a name. Returns `path:line: [topic, date] text`."""
        if exact:
            return self.grep_chats(query)
        self.on_step("recall", f"earlier chats for {query}")
        manifest = self.corpus._read_manifest(remote=False)
        key = (str(self.corpus.root), tuple(sorted(manifest.items())))

        def load():
            units = []
            for rel in self.topic_files():
                units += search.units_for(rel, "\n".join(self.corpus.read_lines(rel)))
            return units

        hits = search.cut(search.index_for(key, load).search(query, since))
        if not hits:
            return "No matches in earlier chats. Try other words, list_chat_topics, or exact=true for a phrase."
        return "\n".join(f"{self.shown(u.path)}:{u.line}: [{u.topic}, {u.last}] "
                         f"{u.text.strip().replace(chr(10), ' ')[:search.SNIPPET_CHARS]}" for _, u in hits)

    def grep_chats(self, pattern: str, path: str = "") -> str:
        """Search the text of earlier chat topics with a case insensitive regular expression (like grep), for an
        exact word or phrase. Optionally limit to one `path`. Returns `path:line: text` matches. The agent reaches
        this through search_chats(exact=true): this model stops answering when it is given more than six tools."""
        self.on_step("recall", f"earlier chats for {pattern}")
        try:
            rx = re.compile(pattern, re.IGNORECASE)
        except re.error:
            rx = re.compile(re.escape(pattern), re.IGNORECASE)
        targets = [self._rel(path)] if path else self.topic_files()
        hits: list[str] = []
        total = 0
        for rel in targets:
            for n, line in enumerate(self.corpus.read_lines(rel), start=1):
                if rx.search(line):
                    total += 1
                    if len(hits) < MAX_SEARCH_HITS:
                        hits.append(f"{self.shown(rel)}:{n}: {line.strip()[:MAX_LINE_CHARS]}")
        if not hits:
            return "No matches in earlier chats."
        out = "\n".join(hits)
        return out + (f"\n... {total - len(hits)} more matches. Narrow the pattern." if total > len(hits) else "")

    def read_chat(self, path: str, start_line: int = 1, end_line: int = 0) -> str:
        """Read an earlier chat topic with line numbers (its summary, then the exact words that were kept). Reads at
        most 160 lines per call. Cite with these line numbers."""
        rel = self._rel(path)
        lines = self.corpus.read_lines(rel)
        start = max(1, start_line)
        end = min(len(lines), end_line if end_line >= start else start + MAX_READ_LINES - 1)
        end = min(end, start + MAX_READ_LINES - 1)
        self.on_step("recall", f"{rel} (lines {start} to {end})")
        body = "\n".join(f"{n}| {lines[n - 1]}" for n in range(start, end + 1))
        more = f"\n[{len(lines) - end} more lines]" if end < len(lines) else ""
        return f"{self.shown(rel)} ({len(lines)} lines)\n{body}{more}"

    def quote(self, path: str, start: int, end: int) -> str | None:
        """Text of a cited line range, or None if the citation does not point at real content."""
        try:
            rel = self._rel(path)
            lines = self.corpus.read_lines(rel)
        except CorpusError:
            return None
        if start < 1 or start > len(lines):
            return None
        end = max(start, min(end, len(lines), start + 40))
        text = "\n".join(lines[start - 1:end]).strip()
        return text or None
