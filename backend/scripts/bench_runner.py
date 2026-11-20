"""One version of the notebook chat, driven by scripts/chat_benchmark.py. Not meant to be run by hand.

It imports `app` from --app-root (the current checkout, or a git worktree of an older commit), so the same benchmark
runs the real code of each version. It reads one JSON command per line on stdin and answers with one JSON line on
stdout; everything else the app prints goes to stderr.

Commands:
  {"cmd": "ask", "rows": [...], "fault": null | "missing_files" | ...}  -> {"results": [...]}
  {"cmd": "quit"}

A command's rows are one chat: they share history, as a follow up needs the turns before it. Only this file's code
must work against both versions, so it uses only seams that exist in both (research(), writer.stream_answer,
writer._completion, ScopedTools, jev.decide, litellm.completion, Corpus.read_lines) and passes research() only the
keyword arguments it accepts."""

import argparse
import contextlib
import functools
import inspect
import json
import os
import random
import re
import shutil
import sys
import threading
import time
import traceback
import uuid
from pathlib import Path

FAULTS = ("missing_files", "unreadable_files", "jev_down", "llm_timeout", "writer_error")
_LINE_NO = re.compile(r"(?m)^\s*\d+\|\s?")


def norm(text: str) -> str:
    """Text compared for the gold snippets: no line-number prefixes, lower case, single spaces."""
    return " ".join(_LINE_NO.sub(" ", text or "").lower().split())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--app-root", required=True)
    ap.add_argument("--arm", required=True)
    ap.add_argument("--workspace", required=True)
    ap.add_argument("--posts", required=True, help="posts.json: path -> title")
    ap.add_argument("--notebook-title", default="My research notes")
    ap.add_argument("--question-timeout", type=float, default=240)
    args = ap.parse_args()

    # The protocol keeps the real stdout; anything the app prints goes to stderr.
    proto = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
    os.dup2(2, 1)
    sys.stdout = sys.stderr

    sys.path.insert(0, str(Path(args.app_root).resolve()))
    import logging

    logging.basicConfig(level=logging.ERROR)
    for name in ("LiteLLM", "litellm", "httpx", "dspy", "app"):
        logging.getLogger(name).setLevel(logging.ERROR)

    import dspy
    import litellm

    from app.config import settings
    from app.corpus import Corpus, CorpusError, ScopedTools
    from app.llm import provider
    from app.pipeline import research as rs
    from app.pipeline import writer
    from app.pipeline.trace import ChatTrace
    from app.services import jev

    # Every cache off: a repeated question is a real request.
    provider.configure_default()
    with contextlib.suppress(Exception):
        dspy.configure_cache(enable_disk_cache=False, enable_memory_cache=False)
    for maker in ("main_lm", "agent_lm", "fast_lm", "triage_lm", "writer_lm"):
        fn = getattr(provider, maker, None)
        if fn is not None:
            with contextlib.suppress(Exception):
                fn().cache = False

    corpus = Corpus(uuid.UUID(args.workspace))
    allowed: dict[str, str] = json.loads(Path(args.posts).read_text("utf-8"))
    corpus.sync()
    accepted = set(inspect.signature(rs.research).parameters)
    has_outcome = hasattr(rs, "outcome_of")
    import app

    info = {"arm": args.arm, "app_root": args.app_root, "app_file": app.__file__, "router": bool(getattr(settings, "chat_router", False)),
            "posts": len(allowed), "has_outcome": has_outcome}
    print(f"[runner {args.arm}] ready: {info}", file=sys.stderr)

    class Probe:
        """What one run did: model calls, and the passages the answer writer and the agent's tools saw."""

        def __init__(self):
            self.model_calls = self.jev_calls = 0
            self.evidence: list[str] = []
            self.fault_hits = 0

    @contextlib.contextmanager
    def watch(probe: Probe):
        saved = (litellm.completion, writer.stream_answer, jev.decide, ScopedTools.read, ScopedTools.search)

        def completion(*a, **kw):  # every model call: dspy and the answer writer both go through litellm.completion
            probe.model_calls += 1
            return saved[0](*a, **kw)

        def stream_answer(inputs, evidence, *a, **k):
            probe.evidence += [inputs.get("prefetched") or "", evidence or ""]
            return saved[1](inputs, evidence, *a, **k)

        def decide(*a, **k):
            probe.jev_calls += 1
            return saved[2](*a, **k)

        def tool(fn):
            @functools.wraps(fn)  # the agent reads the tool's name, docstring and type hints
            def wrapped(tools, *a, **k):
                out = fn(tools, *a, **k)
                probe.evidence.append(str(out))
                return out

            return wrapped

        litellm.completion, writer.stream_answer, jev.decide = completion, stream_answer, decide
        ScopedTools.read, ScopedTools.search = tool(saved[3]), tool(saved[4])
        try:
            yield
        finally:
            litellm.completion, writer.stream_answer, jev.decide, ScopedTools.read, ScopedTools.search = saved

    def storage_file(rel: str) -> Path:
        return Path(settings.local_storage_dir).resolve() / f"ws/{args.workspace}/corpus/{rel}"

    @contextlib.contextmanager
    def fault(name: str | None, gold_paths: set[str], probe: Probe):
        """Break one thing for the length of a run. Every fault is undone afterwards, the files included."""
        if not name:
            yield
            return
        rng = random.Random(name)
        others = sorted(p for p in allowed if p not in gold_paths)
        victims = rng.sample(others, 3)
        if name == "missing_files":  # listed in the manifest, gone from storage and the disk cache
            manifest = storage_file("manifest.json")
            backup = manifest.read_bytes()
            moved = []
            for rel in victims:
                for src in (storage_file(rel), corpus._local(rel)):
                    if src.exists():
                        dst = src.with_name(src.name + ".bench-moved")
                        shutil.move(src, dst)
                        moved.append((dst, src))
            probe.fault_hits = len(moved)
            try:
                yield
            finally:
                for dst, src in moved:
                    if dst.exists():
                        shutil.move(dst, src)
                manifest.write_bytes(backup)
                corpus.sync()
            return
        if name == "unreadable_files":
            real = Corpus.read_lines

            def read_lines(self, rel):
                if rel in victims:
                    probe.fault_hits += 1
                    raise CorpusError(f"Could not read {rel} (benchmark fault)")
                return real(self, rel)

            Corpus.read_lines = read_lines
            try:
                yield
            finally:
                Corpus.read_lines = real
            return
        if name == "jev_down":
            real = jev.decide

            def decide(*a, **k):
                probe.fault_hits += 1
                raise jev.JevError("TypeSafe is down (benchmark fault)")

            jev.decide = decide
            try:
                yield
            finally:
                jev.decide = real
            return
        if name == "llm_timeout":  # the first model call of the run times out
            real = litellm.completion

            def completion(*a, **k):
                if not probe.fault_hits:
                    probe.fault_hits += 1
                    raise litellm.exceptions.Timeout("benchmark fault: request timed out",
                                                     model=str(k.get("model", "")), llm_provider="openai")
                return real(*a, **k)

            litellm.completion = completion
            try:
                yield
            finally:
                litellm.completion = real
            return
        if name == "writer_error":  # the first call of the answer writer fails
            real = writer._completion

            def completion(**kw):
                if not probe.fault_hits:
                    probe.fault_hits += 1
                    raise litellm.exceptions.APIConnectionError("benchmark fault: connection reset",
                                                                llm_provider="openai", model=str(kw.get("model", "")))
                return real(**kw)

            writer._completion = completion
            try:
                yield
            finally:
                writer._completion = real
            return
        raise ValueError(f"unknown fault {name!r}")

    def ask_one(row: dict, history: list, last_answer, fault_name: str | None) -> tuple[dict, object]:
        probe = Probe()
        first: list[float] = []
        box: dict = {}

        def on_delta(text):
            if text is None:
                first.clear()
            elif text and not first:
                first.append(time.perf_counter() - start)

        kwargs = {"history": list(history), "notebook_title": args.notebook_title, "profile": "",
                  "trace": ChatTrace(message=row["question"]), "last_answer": last_answer, "on_delta": on_delta}
        kwargs = {k: v for k, v in kwargs.items() if k in accepted}
        gold_paths = set(filter(None, row.get("gold_paths", [])))

        def work():
            try:
                box["result"] = rs.research(corpus, allowed, row["question"], **kwargs)
            except BaseException as exc:  # noqa: BLE001 - kept with the run, not lost
                box["error"] = exc
                box["tb"] = traceback.format_exc(limit=8)

        start = time.perf_counter()
        with fault(fault_name, gold_paths, probe), watch(probe):
            t = threading.Thread(target=work, daemon=True)
            t.start()
            t.join(args.question_timeout)
        total = time.perf_counter() - start
        result = box.get("result")
        error, error_type = "", ""
        if t.is_alive():
            error_type, error = "BenchTimeout", f"no answer after {args.question_timeout:.0f}s"
        elif "error" in box:
            exc = box["error"]
            error_type = type(exc).__name__
            error = " ".join(str(exc).split())[:300]
        cites = list(result.citations) if result else []
        evidence = "\n\n".join(e for e in probe.evidence if e)
        ev_norm = norm(evidence)
        snippets = row.get("gold_snippets") or []
        # Each gold post must reach the writer: a snippet of each, any of the post's snippets counts.
        by_path: dict[str, list[str]] = {}
        for s in snippets:
            by_path.setdefault(s["path"], []).append(norm(s["text"]))
        evidence_hit = (all(any(s and s in ev_norm for s in ss) for ss in by_path.values()) if by_path else None)
        recall = (result.recall or {}) if result else {}
        rec = {
            "arm": args.arm, "id": row["id"], "case": row.get("case", ""), "fault": fault_name or "",
            "question": row["question"],
            "answer": result.text if result else "",
            "kind": result.kind if result else "error",
            "path": (recall.get("path") or result.kind) if result else "error",
            "outcome": rs.outcome_of(result) if (result and has_outcome) else "",
            "unsupported": bool(result.unsupported) if result else True,
            "citations": [{"path": c.path, "line_start": c.line_start, "line_end": c.line_end, "quote": c.quote}
                          for c in cites],
            "first_text_s": round(first[0] if first else total, 3), "total_s": round(total, 3),
            "model_calls": probe.model_calls, "jev_calls": probe.jev_calls,
            "prompt_tokens": getattr(result, "prompt_tokens", 0) if result else 0,
            "completion_tokens": getattr(result, "completion_tokens", 0) if result else 0,
            "evidence_hit": evidence_hit, "evidence_chars": len(evidence), "evidence": evidence[:6000],
            "fault_hits": probe.fault_hits, "error_type": error_type, "error": error, "traceback": box.get("tb", ""),
        }
        return rec, result

    for line in sys.stdin:
        if not line.strip():
            continue
        cmd = json.loads(line)
        if cmd.get("cmd") == "quit":
            break
        if cmd.get("cmd") == "info":
            proto.write(json.dumps(info) + "\n")
            continue
        results, history, last_answer = [], [], None
        for row in cmd["rows"]:
            rec, result = ask_one(row, history, last_answer, cmd.get("fault"))
            rec["scored"] = bool(row.get("scored", True))
            results.append(rec)
            history += [rs.Turn("user", row["question"]), rs.Turn("assistant", rec["answer"])]
            if result is not None and result.citations:
                last_answer = rs.LastAnswer(result.text, result.citations)
        proto.write(json.dumps({"results": results}, default=str) + "\n")
    proto.close()


if __name__ == "__main__":
    main()
