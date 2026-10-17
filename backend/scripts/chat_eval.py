"""Old vs new notebook chat, measured: speed, model calls, tokens, retrieval, a blind quality judge and RAGAS, to CSV.

"old" is the research agent alone (prefetch, the fast/overview/rewrite paths, parallel parts and streaming all off).
"new" is the chat as it runs now. Both run the same questions on the same notebook, in-process through research(),
with every model cache off, alternating which mode goes first. Nothing is written to the database.

Setup (once):
  cd backend && .venv/bin/pip install -r requirements.txt   # includes ragas and scipy
  .venv/bin/python scripts/chat_eval.py notebooks      # lists notebooks with their ids and post counts

1. A labelled question set (each question written by GLM from one passage, so the right lines are known):
  .venv/bin/python scripts/chat_eval.py make-questions --notebook <id> --n 40 --out eval/synthetic.csv
  Read it and delete bad or ambiguous questions: this matters more than anything else for a trustworthy result.

2. A smoke test (a few minutes):
  .venv/bin/python scripts/chat_eval.py run --notebook <id> --questions eval/questions.csv --limit 3 --repeats 1 \\
      --no-judge --no-ragas

3. The full run (about 1 to 1.5 hours, real GLM tokens; run at a quiet time and do not chat meanwhile):
  .venv/bin/python scripts/chat_eval.py run --notebook <id> --questions eval/questions.csv eval/synthetic.csv --repeats 3

Results go to chat_eval_results/<timestamp>/: compare.csv (one row per question, old vs new side by side),
summary.csv (one row per metric with confidence intervals and p-values), runs.csv, judge.csv and ragas.csv (raw).
Without --notebook, the notebook of the most recent chat is used."""

import argparse
import asyncio
import contextlib
import csv
import functools
import logging
import random
import re
import statistics
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Literal

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import dspy  # noqa: E402
import numpy as np  # noqa: E402
from sqlalchemy import select  # noqa: E402
from sqlalchemy.orm import load_only  # noqa: E402

from app.config import settings  # noqa: E402
from app.corpus import Corpus, ScopedTools  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app.llm import provider  # noqa: E402
from app.models import Chat, Document, Notebook, NotebookDocument  # noqa: E402
from app.pipeline import prefetch as pf  # noqa: E402
from app.pipeline import research as rs  # noqa: E402
from app.pipeline import writer  # noqa: E402
from app.pipeline.trace import ChatTrace  # noqa: E402
from app.services import jev  # noqa: E402
from app.services.memory import list_facts, profile_text  # noqa: E402

MODES = ("old", "new")
NO_RESEARCH = ("chitchat", "off_topic", "about_app", "error")  # replies that never touch the posts
FIELDS = ("id", "group", "question", "expected_fact", "reference_answer", "gold_path", "gold_lines")
log = logging.getLogger("chat_eval")


# Notebook and questions


def load_notebook(notebook_id: str | None):
    db = SessionLocal()
    nid = uuid.UUID(notebook_id) if notebook_id else db.scalar(
        select(Chat.notebook_id).order_by(Chat.updated_at.desc()).limit(1))
    nb = db.get(Notebook, nid)
    if nb is None:
        sys.exit("No notebook found: pass --notebook <id>")
    query = (select(Document).join(NotebookDocument, NotebookDocument.document_id == Document.id)
             .where(NotebookDocument.notebook_id == nb.id, Document.path.is_not(None)))
    timings = {"full": [], "columns": []}  # the endpoint's posts query, before and after it loaded only 6 columns
    for _ in range(5):
        t = time.perf_counter()
        db.scalars(query).all()
        timings["full"].append(time.perf_counter() - t)
        db.expunge_all()
        t = time.perf_counter()
        docs = db.scalars(query.options(load_only(Document.id, Document.path, Document.title, Document.url,
                                                  Document.content_hash, Document.updated_at))).all()
        timings["columns"].append(time.perf_counter() - t)
        db.expunge_all()
    allowed = {d.path: d.title for d in docs}
    corpus = Corpus(nb.workspace_id)
    manifest = corpus.sync()
    profile = profile_text(list_facts(db, nb.workspace_id))
    db.close()
    return nb, allowed, corpus, manifest, profile, timings


def read_questions(paths: list[str], limit: int | None) -> list[dict]:
    rows: list[dict] = []
    for path in paths:
        with open(path, newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                if (row.get("question") or "").strip():
                    rows.append({k: (row.get(k) or "").strip() for k in FIELDS})
    for i, row in enumerate(rows):
        row["id"] = row["id"] or f"q{i + 1:03d}"
        row["group"] = row["group"] or row["id"]
    if limit:
        keep = list(dict.fromkeys(r["group"] for r in rows))[:limit]
        rows = [r for r in rows if r["group"] in keep]
    return rows


def gold(row: dict) -> tuple[str, int, int] | None:
    m = re.fullmatch(r"(\d+)\s*-\s*(\d+)", row.get("gold_lines") or "")
    return (row["gold_path"], int(m.group(1)), int(m.group(2))) if row.get("gold_path") and m else None


def overlaps(g: tuple[str, int, int] | None, path: str, start: int, end: int) -> bool:
    return bool(g) and path == g[0] and start <= g[2] and g[1] <= end


# Model setup: every cache off, so a repeated question is a real request


def models_without_cache() -> None:
    provider.configure_default()
    with contextlib.suppress(Exception):
        dspy.configure_cache(enable_disk_cache=False, enable_memory_cache=False)
    for lm in (provider.main_lm(), provider.fast_lm(), provider.triage_lm(), provider.writer_lm(),
               provider.main_lm("high")):
        lm.cache = False


# notebooks


def list_notebooks(_args) -> None:
    from sqlalchemy import func
    db = SessionLocal()
    searchable = func.count(func.distinct(Document.id))  # posts with a markdown file: what the chat can search
    counts = (select(Notebook.id, Notebook.title, searchable, func.max(Chat.updated_at))
              .join(NotebookDocument, NotebookDocument.notebook_id == Notebook.id, isouter=True)
              .join(Document, (Document.id == NotebookDocument.document_id) & Document.path.is_not(None), isouter=True)
              .join(Chat, Chat.notebook_id == Notebook.id, isouter=True)
              .group_by(Notebook.id, Notebook.title))
    rows = db.execute(counts).all()
    rows = sorted(rows, key=lambda r: (r[3] is not None, r[3].timestamp() if r[3] else 0), reverse=True)
    print(f"{'id':38} {'posts':>5}  {'last chat':16}  title")
    for nid, title, n, last in rows:
        print(f"{nid!s:38} {n:5}  {last.strftime('%Y-%m-%d %H:%M') if last else '-':16}  {title}")
    db.close()


# make-questions


class WriteQuestion(dspy.Signature):
    """Write one question a writer might ask a research assistant about their own blog archive, answered by this
    passage and by nothing else in a typical archive: specific (a name, number, method, recommendation or opinion in
    the passage), in the writer's voice ("what did I say about...", "how do I..."), never mentioning the passage. Then
    give the short correct answer from the passage. If the passage holds nothing worth asking about (navigation,
    boilerplate, a list of links), leave both empty."""

    post_title: str = dspy.InputField()
    passage: str = dspy.InputField()
    question: str = dspy.OutputField()
    answer: str = dspy.OutputField(desc="One or two sentences, only from the passage")


def make_questions(args) -> None:
    models_without_cache()
    _, allowed, corpus, manifest, _, _ = load_notebook(args.notebook)
    passages = [p for p in pf._index(corpus, allowed, manifest).units if sum(len(x) for x in p.lines) >= 300]
    rng = random.Random(args.seed)
    rng.shuffle(passages)
    picked, seen_posts = [], set()
    for p in passages:  # spread over posts first, then allow seconds
        if p.path not in seen_posts:
            picked.append(p)
            seen_posts.add(p.path)
    picked += [p for p in passages if p not in picked]
    rows, lm = [], provider.main_lm()
    for p in picked:
        if len(rows) >= args.n:
            break
        try:
            with dspy.context(lm=lm):
                out = dspy.Predict(WriteQuestion)(post_title=p.title, passage="\n".join(p.lines))
        except Exception as exc:
            print(f"  skipped {p.path}:{p.start}: {type(exc).__name__}")
            continue
        q, a = (out.question or "").strip(), (out.answer or "").strip()
        if not q or not a:
            continue
        i = len(rows) + 1
        rows.append({"id": f"s{i:03d}", "group": f"s{i:03d}", "question": q, "expected_fact": "",
                     "reference_answer": a, "gold_path": p.path, "gold_lines": f"{p.start}-{p.end}"})
        print(f"  {i:3d}. {q}")
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)
    print(f"Wrote {len(rows)} questions to {args.out}. Read them and delete bad or ambiguous ones before a run.")


# Instrumentation: what each run did


class Probe:
    """Counts model calls and records what the run read, by wrapping the seams research() goes through."""

    def __init__(self):
        self.writer_calls = self.jev_calls = 0
        self.contexts: list[str] = []  # passages handed to the model that writes the answer
        self.reads: list[tuple[str, int, int, str]] = []  # what the agent read: path, first line, last line, text
        self.prefetch: pf.Prefetch | None = None

    @contextlib.contextmanager
    def watch(self, mode: str):
        saved = {"completion": writer._completion, "stream": writer.stream_answer, "decide": jev.decide,
                 "read": ScopedTools.read, "prefetch": rs.prefetch,
                 "flags": (settings.chat_fast_path, settings.chat_stream_answers, settings.chat_parallel_parts)}
        probe = self

        def completion(**kw):
            probe.writer_calls += 1
            return saved["completion"](**kw)

        def stream_answer(inputs, evidence, *a, **k):
            for text in (inputs.get("prefetched") or "", evidence or ""):
                probe.contexts += [c for c in text.split("\n\n") if c.strip() and not c.startswith("(")]
            return saved["stream"](inputs, evidence, *a, **k)

        def decide(*a, **k):
            probe.jev_calls += 1
            return saved["decide"](*a, **k)

        @functools.wraps(saved["read"])  # the agent reads the tool's description from its docstring
        def read(tools, path, start_line=1, end_line=0):
            out = saved["read"](tools, path, start_line, end_line)
            numbers = [int(m) for m in re.findall(r"^(\d+)\| ", out, re.M)]
            if numbers:
                probe.reads.append((out.split(" ", 1)[0], numbers[0], numbers[-1], out))
            return out

        def prefetch(*a, **k):
            probe.prefetch = saved["prefetch"](*a, **k)
            return probe.prefetch

        writer._completion, writer.stream_answer, jev.decide, ScopedTools.read = completion, stream_answer, decide, read
        if mode == "old":
            settings.chat_fast_path = settings.chat_stream_answers = settings.chat_parallel_parts = False
            rs.prefetch = lambda *a, **k: pf.Prefetch()
        else:
            settings.chat_fast_path = settings.chat_stream_answers = settings.chat_parallel_parts = True
            rs.prefetch = prefetch
        try:
            yield self
        finally:
            writer._completion, writer.stream_answer, jev.decide = saved["completion"], saved["stream"], saved["decide"]
            ScopedTools.read, rs.prefetch = saved["read"], saved["prefetch"]
            settings.chat_fast_path, settings.chat_stream_answers, settings.chat_parallel_parts = saved["flags"]


def history_entries(clear: bool = False) -> int:
    """dspy model calls since the last clear (its global history keeps at most 10,000 entries, so it is cleared before
    each run rather than compared across the whole evaluation)."""
    from dspy.clients.base_lm import GLOBAL_HISTORY
    if clear:
        GLOBAL_HISTORY.clear()
    return len(GLOBAL_HISTORY)


def run_one(row, mode, repeat, nb, allowed, corpus, profile, history, last_answer) -> tuple[dict, object]:
    probe = Probe()
    first: list[float] = []  # when the text that stayed began: a draft taken back (on_delta(None)) does not count

    def on_delta(text: str | None) -> None:
        if text is None:
            first.clear()
        elif text and not first:
            first.append(time.perf_counter() - start)

    calls_before = history_entries(clear=True)
    start = time.perf_counter()
    result, error = None, ""
    with probe.watch(mode):
        try:
            result = rs.research(corpus, allowed, row["question"], history=list(history), notebook_title=nb.title,
                                 profile=profile, trace=ChatTrace(message=row["question"]), last_answer=last_answer,
                                 on_delta=on_delta)
        except Exception as exc:  # keep the run, with the error, instead of losing the question
            error = f"{type(exc).__name__}: {' '.join(str(exc).split())[:200]}"
    total = time.perf_counter() - start
    g = gold(row)
    text = result.text if result else ""
    cites = result.citations if result else []
    contexts = probe.contexts or [r[3] for r in probe.reads]
    rec = {
        "id": row["id"], "group": row["group"], "question": row["question"], "mode": mode, "repeat": repeat,
        "path": (result.recall.get("path") or result.kind) if result else "error",
        "first_text_s": round(first[0] if first else total, 3), "total_s": round(total, 3),
        "model_calls": history_entries() - calls_before + probe.writer_calls, "jev_calls": probe.jev_calls,
        "prompt_tokens": result.prompt_tokens if result else 0,
        "completion_tokens": result.completion_tokens if result else 0,
        "citations": len(cites), "unsupported": bool(result.unsupported) if result else True,
        "words": len(text.split()), "answer": text, "error": error,
        "cite_hit": int(any(overlaps(g, c.path, c.line_start, c.line_end) for c in cites)) if g else "",
        "read_recall": "", "recall_at_k": "", "mrr": "", "precision_at_k": "",
        "contexts": contexts[:12], "quotes": [f"{c.path} lines {c.line_start}-{c.line_end}: {c.quote}" for c in cites],
    }
    if g and mode == "old":
        rec["read_recall"] = int(any(overlaps(g, p, a, b) for p, a, b, _ in probe.reads))
    if g and mode == "new" and probe.prefetch is not None:
        picked = [p for _, p in probe.prefetch.passages]
        sent = picked + probe.prefetch.added
        rec["recall_at_k"] = int(any(overlaps(g, p.path, p.start, p.end) for p in sent))
        rank = next((i for i, p in enumerate(picked, start=1) if overlaps(g, p.path, p.start, p.end)), None)
        rec["mrr"] = round(1 / rank, 3) if rank else 0
        rec["precision_at_k"] = round(sum(p.path == g[0] for p in picked) / len(picked), 3) if picked else 0
    return rec, result


# The judge: pairwise, both orders


class JudgeAnswers(dspy.Signature):
    """You grade two answers from a research assistant that answers questions about a writer's blog archive. Judge
    them only against the evidence (passages from the archive) and the reference, if one is given. Score each answer
    from 1 (bad) to 5 (excellent) on: correct (no false or unsupported statements), complete (covers what the question
    asks, as far as the evidence allows), grounded (claims backed by the evidence), concise (no padding or repetition;
    the right length for the question). has_fact: "yes" if the answer states the expected fact, "no" if it does not,
    "n/a" when no expected fact is given. An honest "the archive does not cover this" is correct when the evidence
    does not answer the question. Then pick the better answer overall, or "tie" when they are equally good."""

    question: str = dspy.InputField()
    evidence: str = dspy.InputField()
    reference: str = dspy.InputField(desc="A reference answer and/or an expected fact, or (none)")
    answer_a: str = dspy.InputField()
    answer_b: str = dspy.InputField()
    a_correct: int = dspy.OutputField()
    a_complete: int = dspy.OutputField()
    a_grounded: int = dspy.OutputField()
    a_concise: int = dspy.OutputField()
    a_has_fact: Literal["yes", "no", "n/a"] = dspy.OutputField()
    b_correct: int = dspy.OutputField()
    b_complete: int = dspy.OutputField()
    b_grounded: int = dspy.OutputField()
    b_concise: int = dspy.OutputField()
    b_has_fact: Literal["yes", "no", "n/a"] = dspy.OutputField()
    winner: Literal["A", "B", "tie"] = dspy.OutputField()
    reason: str = dspy.OutputField(desc="One sentence")


SCORES = ("correct", "complete", "grounded", "concise")


def judge_question(row, old, new) -> tuple[dict, list[dict]]:
    lm = provider.main_lm("high")
    reference = "\n".join(x for x in (row["reference_answer"] and f"Reference answer: {row['reference_answer']}",
                                      row["expected_fact"] and f"Expected fact: {row['expected_fact']}") if x)
    evidence = "\n\n".join(dict.fromkeys(old["quotes"] + new["quotes"]))[:20000] or "(no passages were cited)"
    raw, by_mode = [], {m: {s: [] for s in SCORES} | {"has_fact": []} for m in MODES}
    winners = []
    for first in MODES:  # both orders: old as A, then new as A
        a, b = (old, new) if first == "old" else (new, old)
        try:
            with dspy.context(lm=lm):
                out = dspy.Predict(JudgeAnswers)(question=row["question"], evidence=evidence,
                                                 reference=reference or "(none)",
                                                 answer_a=a["answer"] or "(no answer)",
                                                 answer_b=b["answer"] or "(no answer)")
        except Exception as exc:
            raw.append({"id": row["id"], "order": f"{first} as A", "error": f"{type(exc).__name__}: {exc}"[:300]})
            continue
        side = {"A": a["mode"], "B": b["mode"], "tie": "tie"}
        winners.append(side[out.winner])
        for letter, mode in (("a", a["mode"]), ("b", b["mode"])):
            for s in SCORES:
                by_mode[mode][s].append(int(getattr(out, f"{letter}_{s}")))
            by_mode[mode]["has_fact"].append(getattr(out, f"{letter}_has_fact"))
        raw.append({"id": row["id"], "order": f"{first} as A", "winner": side[out.winner], "reason": out.reason,
                    **{f"{m}_{s}": by_mode[m][s][-1] for m in MODES for s in SCORES}, "error": ""})
    consistent = len(winners) == 2 and winners[0] == winners[1]
    out = {"judge_winner": winners[0] if consistent else ("tie" if winners else ""),
           "judge_consistent": consistent if winners else "",
           "judge_reason": next((r["reason"] for r in raw if r.get("reason")), "")}
    for m in MODES:
        for s in SCORES:
            vals = by_mode[m][s]
            out[f"{m}_{s}"] = round(statistics.mean(vals), 2) if vals else ""
        facts = set(by_mode[m]["has_fact"])
        out[f"{m}_has_fact"] = facts.pop() if len(facts) == 1 else ("mixed" if facts else "")
    return out, raw


# RAGAS, with GLM as its model


async def ragas_scores(items: list[tuple[dict, dict]]) -> list[dict]:
    from openai import AsyncOpenAI
    from ragas.llms import llm_factory
    from ragas.metrics.collections import ContextPrecisionWithoutReference, ContextRecall, Faithfulness

    client = AsyncOpenAI(base_url=settings.llm_api_base or None, api_key=settings.llm_api_key)
    extra = provider._extra_kwargs(None).get("extra_body")
    llm = llm_factory(settings.llm_model.split("/", 1)[-1], provider="openai", client=client, max_tokens=8000,
                      **({"extra_body": extra} if extra else {}))
    faith, precision, recall = Faithfulness(llm=llm), ContextPrecisionWithoutReference(llm=llm), ContextRecall(llm=llm)
    gate = asyncio.Semaphore(4)

    async def one(row: dict, rec: dict) -> dict:
        out = {"id": row["id"], "mode": rec["mode"], "faithfulness": "", "context_precision": "",
               "context_recall": "", "error": ""}
        contexts = [c[:4000] for c in rec["contexts"]] or ["(nothing was read)"]
        jobs = {"faithfulness": faith.ascore(user_input=row["question"], response=rec["answer"] or "(no answer)",
                                             retrieved_contexts=contexts),
                "context_precision": precision.ascore(user_input=row["question"], response=rec["answer"] or "-",
                                                      retrieved_contexts=contexts)}
        if row["reference_answer"]:
            jobs["context_recall"] = recall.ascore(user_input=row["question"], retrieved_contexts=contexts,
                                                   reference=row["reference_answer"])
        errors = []
        for name, job in jobs.items():
            async with gate:
                try:
                    out[name] = round(float((await job).value), 3)
                except Exception as exc:
                    errors.append(f"{name}: {type(exc).__name__}")
        out["error"] = "; ".join(errors)
        return out

    return await asyncio.gather(*(one(row, rec) for row, rec in items))


# Statistics


def wilcoxon_p(old: list[float], new: list[float]) -> float | str:
    from scipy.stats import wilcoxon
    pairs = [(a, b) for a, b in zip(old, new, strict=True) if a != "" and b != ""]
    if len(pairs) < 5 or all(a == b for a, b in pairs):
        return ""
    return round(float(wilcoxon([a for a, _ in pairs], [b for _, b in pairs]).pvalue), 5)


def bootstrap(values: list, stat, n: int = 10000, seed: int = 7) -> tuple[float | str, float | str]:
    if len(values) < 3:
        return "", ""
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, len(values), size=(n, len(values)))
    stats = [stat([values[i] for i in row]) for row in idx]
    stats = [s for s in stats if s is not None and not np.isnan(s)]
    if not stats:
        return "", ""
    return round(float(np.percentile(stats, 2.5)), 4), round(float(np.percentile(stats, 97.5)), 4)


def med(xs: list) -> float | str:
    xs = [x for x in xs if x != ""]
    return round(statistics.median(xs), 3) if xs else ""


def p90(xs: list) -> float | str:
    xs = sorted(x for x in xs if x != "")
    return round(xs[min(len(xs) - 1, int(len(xs) * 0.9))], 3) if xs else ""


def mean(xs: list) -> float | str:
    xs = [float(x) for x in xs if x not in ("", None)]
    return round(statistics.mean(xs), 3) if xs else ""


# run


def run(args) -> None:
    models_without_cache()
    rows = read_questions(args.questions, args.limit)
    nb, allowed, corpus, manifest, profile, setup = load_notebook(args.notebook)
    out_dir = Path(args.out or Path(__file__).resolve().parents[1] / "chat_eval_results" /
                   datetime.now().strftime("%Y%m%d-%H%M%S"))
    out_dir.mkdir(parents=True, exist_ok=True)
    groups: dict[str, list[dict]] = {}
    for row in rows:
        groups.setdefault(row["group"], []).append(row)
    print(f"Notebook {nb.title!r} ({nb.id}): {len(allowed)} posts | {len(rows)} questions in {len(groups)} group(s) | "
          f"{args.repeats} repeat(s) | results in {out_dir}")

    runs: list[dict] = []
    total_runs = len(rows) * len(MODES) * args.repeats
    for repeat in range(args.repeats):
        for gi, (_, group_rows) in enumerate(groups.items()):
            order = MODES if (repeat + gi) % 2 == 0 else tuple(reversed(MODES))  # alternate who goes first
            for mode in order:
                history: list[rs.Turn] = []
                last_answer = None
                for row in group_rows:  # a group shares its history: follow ups need the turns before them
                    rec, result = run_one(row, mode, repeat, nb, allowed, corpus, profile, history, last_answer)
                    runs.append(rec)
                    history += [rs.Turn("user", row["question"]), rs.Turn("assistant", rec["answer"])]
                    if result is not None and result.citations:
                        last_answer = rs.LastAnswer(result.text, result.citations)
                    print(f"  [{len(runs):4d}/{total_runs}] r{repeat + 1} {mode:3} {row['id']:5} {rec['path']:15} "
                          f"first {rec['first_text_s']:6.1f}s  total {rec['total_s']:6.1f}s  calls "
                          f"{rec['model_calls']:2}  {rec['error'][:60]}")

    first_runs = {(r["id"], r["mode"]): r for r in runs if r["repeat"] == 0}
    judged: dict[str, dict] = {}
    judge_raw: list[dict] = []
    if not args.no_judge:
        print("Judging (both orders)...")
        with ThreadPoolExecutor(max_workers=4) as ex:
            futures = {row["id"]: ex.submit(judge_question, row, first_runs[(row["id"], "old")],
                                            first_runs[(row["id"], "new")]) for row in rows}
            for qid, f in futures.items():
                judged[qid], raw = f.result()
                judge_raw += raw
    ragas_rows: list[dict] = []
    if not args.no_ragas:
        print("RAGAS (faithfulness, context precision, context recall)...")
        items = [(row, first_runs[(row["id"], m)]) for row in rows for m in MODES]
        ragas_rows = asyncio.run(ragas_scores([(r, rec) for r, rec in items if rec["path"] not in NO_RESEARCH]))
    ragas = {(r["id"], r["mode"]): r for r in ragas_rows}

    # compare.csv: one row per question
    compare = []
    for row in rows:
        per = {m: [r for r in runs if r["id"] == row["id"] and r["mode"] == m] for m in MODES}
        c = {"id": row["id"], "group": row["group"], "question": row["question"],
             "runs_per_mode": len(per["new"])}
        for m in MODES:
            rs_ = per[m]
            c[f"{m}_path"] = statistics.mode([r["path"] for r in rs_]) if rs_ else ""
        for metric in ("first_text_s", "total_s"):
            for m in MODES:
                c[f"{m}_{metric}_median"] = med([r[metric] for r in per[m]])
                c[f"{m}_{metric}_p90"] = p90([r[metric] for r in per[m]])
            o, n = c[f"old_{metric}_median"], c[f"new_{metric}_median"]
            c[f"{metric.replace('_s', '')}_speedup_x"] = round(o / n, 2) if o and n else ""
        for metric in ("model_calls", "jev_calls", "prompt_tokens", "completion_tokens", "citations", "words"):
            for m in MODES:
                c[f"{m}_{metric}"] = med([r[metric] for r in per[m]])
        c["calls_saved"] = (c["old_model_calls"] - c["new_model_calls"]) if c["old_model_calls"] != "" else ""
        old_tok = (c["old_prompt_tokens"] or 0) + (c["old_completion_tokens"] or 0)
        new_tok = (c["new_prompt_tokens"] or 0) + (c["new_completion_tokens"] or 0)
        c["token_saving_pct"] = round(100 * (1 - new_tok / old_tok), 1) if old_tok else ""
        for m in MODES:
            c[f"{m}_unsupported_rate"] = mean([int(r["unsupported"]) for r in per[m]])
            c[f"{m}_cite_hit"] = mean([r["cite_hit"] for r in per[m]])
            c[f"{m}_errors"] = sum(1 for r in per[m] if r["error"])
        c["old_read_recall"] = mean([r["read_recall"] for r in per["old"]])
        for k in ("recall_at_k", "mrr", "precision_at_k"):
            c[f"new_{k}"] = mean([r[k] for r in per["new"]])
        j = judged.get(row["id"], {})
        for k in ("judge_winner", "judge_consistent"):
            c[k] = j.get(k, "")
        for m in MODES:
            for s in (*SCORES, "has_fact"):
                c[f"{m}_{s}"] = j.get(f"{m}_{s}", "")
        c["judge_reason"] = j.get("judge_reason", "")
        for m in MODES:
            g = ragas.get((row["id"], m), {})
            for k in ("faithfulness", "context_precision", "context_recall"):
                c[f"{m}_ragas_{k}"] = g.get(k, "")
        c["old_answer"] = first_runs[(row["id"], "old")]["answer"]
        c["new_answer"] = first_runs[(row["id"], "new")]["answer"]
        compare.append(c)

    # summary.csv: one row per metric, paired by question
    summary = []

    def paired(name, key_old, key_new, kind="lower is better"):
        olds = [c[key_old] for c in compare]
        news = [c[key_new] for c in compare]
        pairs = [(o, n) for o, n in zip(olds, news, strict=True) if o != "" and n != ""]
        if not pairs:
            return
        o_vals, n_vals = [float(o) for o, _ in pairs], [float(n) for _, n in pairs]
        diffs = [n - o for o, n in pairs]
        lo, hi = bootstrap(diffs, lambda xs: float(np.mean(xs)))
        summary.append({"metric": name, "old": round(statistics.median(o_vals), 4), "new": round(statistics.median(n_vals), 4),
                        "difference_new_minus_old": round(float(np.mean(diffs)), 4), "ci_low": lo, "ci_high": hi,
                        "p_value": wilcoxon_p(o_vals, n_vals), "n": len(pairs),
                        "note": f"median over questions; difference is the mean paired difference ({kind})"})

    paired("time to first text (s)", "old_first_text_s_median", "new_first_text_s_median")
    paired("total time (s)", "old_total_s_median", "new_total_s_median")
    paired("model calls", "old_model_calls", "new_model_calls")
    paired("prompt tokens", "old_prompt_tokens", "new_prompt_tokens")
    paired("completion tokens", "old_completion_tokens", "new_completion_tokens")
    paired("answer words", "old_words", "new_words", "shorter is the default style")
    paired("verified citations", "old_citations", "new_citations", "higher is better")
    paired("cite_hit (cites the gold lines)", "old_cite_hit", "new_cite_hit", "higher is better")
    for s in SCORES:
        paired(f"judge: {s} (1-5)", f"old_{s}", f"new_{s}", "higher is better")
    for k in ("faithfulness", "context_precision", "context_recall"):
        paired(f"ragas: {k}", f"old_ragas_{k}", f"new_ragas_{k}", "higher is better")

    def ratio_row(name, key_old, key_new):
        pairs = [(c[key_old], c[key_new]) for c in compare if c[key_old] and c[key_new]]
        if not pairs:
            return
        stat = lambda ps: float(np.median([o for o, _ in ps]) / np.median([n for _, n in ps]))  # noqa: E731
        lo, hi = bootstrap(pairs, stat)
        summary.append({"metric": name, "old": "", "new": "", "difference_new_minus_old": round(stat(pairs), 3),
                        "ci_low": lo, "ci_high": hi, "p_value": "", "n": len(pairs),
                        "note": "median old / median new: above 1 means new is faster; proven if ci_low > 1"})

    ratio_row("speed-up, time to first text (x)", "old_first_text_s_median", "new_first_text_s_median")
    ratio_row("speed-up, total time (x)", "old_total_s_median", "new_total_s_median")
    tok = [((c["old_prompt_tokens"] or 0) + (c["old_completion_tokens"] or 0),
            (c["new_prompt_tokens"] or 0) + (c["new_completion_tokens"] or 0)) for c in compare]
    tok = [t for t in tok if t[0]]
    if tok:
        saving = lambda ts: 100 * (1 - sum(n for _, n in ts) / sum(o for o, _ in ts))  # noqa: E731
        lo, hi = bootstrap(tok, saving)
        summary.append({"metric": "token saving (%)", "old": sum(o for o, _ in tok), "new": sum(n for _, n in tok),
                        "difference_new_minus_old": round(saving(tok), 2), "ci_low": lo, "ci_high": hi,
                        "p_value": "", "n": len(tok), "note": "1 - total new tokens / total old tokens"})
    outcomes = [c["judge_winner"] for c in compare if c["judge_winner"]]
    if outcomes:
        decided = [1.0 if o == "new" else 0.0 for o in outcomes if o in MODES]
        lo, hi = bootstrap(decided, lambda xs: float(np.mean(xs))) if decided else ("", "")
        summary.append({"metric": "judge win rate of new (%)", "old": outcomes.count("old"), "new": outcomes.count("new"),
                        "difference_new_minus_old": round(100 * float(np.mean(decided)), 1) if decided else "",
                        "ci_low": round(100 * lo, 1) if lo != "" else "", "ci_high": round(100 * hi, 1) if hi != "" else "",
                        "p_value": "", "n": len(outcomes),
                        "note": f"wins / (wins + losses); old and new columns count wins; ties {outcomes.count('tie')}, "
                                f"judge inconsistent across orders on {sum(1 for c in compare if c['judge_consistent'] is False)}"})
    new_runs = [r for r in runs if r["mode"] == "new" and r["path"] not in NO_RESEARCH]
    if new_runs:
        summary.append({"metric": "new: fell back to the research agent (%)", "old": "", "new": "",
                        "difference_new_minus_old": round(100 * sum(r["path"] == "research agent" for r in new_runs)
                                                          / len(new_runs), 1),
                        "ci_low": "", "ci_high": "", "p_value": "", "n": len(new_runs),
                        "note": "share of new runs that ended in the slow path"})
    summary.append({"metric": "endpoint posts query (s)", "old": round(statistics.median(setup["full"]), 3),
                    "new": round(statistics.median(setup["columns"]), 3),
                    "difference_new_minus_old": round(statistics.median(setup["columns"]) - statistics.median(setup["full"]), 3),
                    "ci_low": "", "ci_high": "", "p_value": "", "n": 5,
                    "note": "all columns (old) vs the 6 the chat uses (new), median of 5; not part of research()"})

    def write(name, data):
        if not data:
            return
        keys = list(dict.fromkeys(k for d in data for k in d))
        with open(out_dir / name, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=keys)
            w.writeheader()
            w.writerows(data)

    write("compare.csv", compare)
    write("summary.csv", summary)
    write("runs.csv", [{k: v for k, v in r.items() if k not in ("contexts", "quotes")} for r in runs])
    write("judge.csv", judge_raw)
    write("ragas.csv", ragas_rows)

    print("\nSummary (full table in summary.csv):")
    for s in summary:
        ci = f"  95% CI [{s['ci_low']}, {s['ci_high']}]" if s["ci_low"] != "" else ""
        p = f"  p={s['p_value']}" if s["p_value"] != "" else ""
        print(f"  {s['metric']:44} old {s['old']!s:>9}  new {s['new']!s:>9}  diff {s['difference_new_minus_old']!s:>9}{ci}{p}")
    print(f"\nWrote {out_dir}")


def main() -> None:
    logging.basicConfig(level=logging.ERROR)
    for name in ("LiteLLM", "litellm", "httpx", "dspy", "app"):
        logging.getLogger(name).setLevel(logging.ERROR)
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("notebooks", help="list notebooks with their ids and post counts")
    mq = sub.add_parser("make-questions", help="write a labelled question set from the notebook's passages")
    mq.add_argument("--notebook")
    mq.add_argument("--n", type=int, default=40)
    mq.add_argument("--seed", type=int, default=7)
    mq.add_argument("--out", default="eval/synthetic.csv")
    rn = sub.add_parser("run", help="run old and new on the questions and write the CSVs")
    rn.add_argument("--notebook")
    rn.add_argument("--questions", nargs="+", default=["eval/questions.csv"])
    rn.add_argument("--repeats", type=int, default=3)
    rn.add_argument("--limit", type=int, help="only the first N question groups (a smoke test)")
    rn.add_argument("--no-judge", action="store_true")
    rn.add_argument("--no-ragas", action="store_true")
    rn.add_argument("--out", help="results folder (default chat_eval_results/<timestamp>)")
    args = ap.parse_args()
    {"notebooks": list_notebooks, "make-questions": make_questions, "run": run}[args.cmd](args)


if __name__ == "__main__":
    main()
