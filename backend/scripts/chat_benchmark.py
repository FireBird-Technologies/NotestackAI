"""The notebook chat before and after the chat overhaul (PR #127), measured on a 2,000-post notebook.

"before" is the real code of the commit before the overhaul (5b06898), checked out into a git worktree;
"now" is this checkout (with CHAT_ROUTER on unless --now-router off). Both answer the same questions on the same
notebook, in-process through research(), each in its own process (scripts/bench_runner.py). Nothing touches the
production database or storage: the notebook lives under backend/.bench/ on this machine.

  cd backend
  .venv/bin/python scripts/chat_benchmark.py all                 # everything below, with the defaults

Step by step:
  .venv/bin/python scripts/chat_benchmark.py build-corpus --posts 2000      # Simple English Wikipedia -> 2,000 posts
                                                                             # + post cards (one fast call per post)
  .venv/bin/python scripts/chat_benchmark.py make-questions --questions 60  # 30 cases x (exact + reworded wording)
  #   read .bench/questions.csv and delete bad rows: the run uses whatever is left
  .venv/bin/python scripts/chat_benchmark.py run                            # both versions + the fault suite, judged
  .venv/bin/python scripts/chat_benchmark.py report --results .bench/results/<timestamp>   # rebuild the report

A smoke test (a few minutes): build-corpus --posts 60 --holdout 10, make-questions --questions 12, run --limit 2.

Results: .bench/results/<timestamp>/report.html (open it in a browser), summary.csv, per_question.csv,
failures.csv, faults.csv, runs.jsonl. Latency is measured in-process, so it leaves out the API's database time."""

import argparse
import csv
import html
import json
import os
import random
import re
import shutil
import statistics
import subprocess
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path
from typing import Literal

BACKEND = Path(__file__).resolve().parents[1]
REPO = BACKEND.parent
BENCH = Path(os.environ.get("CHAT_BENCH_DIR") or BACKEND / ".bench").resolve()  # everything the benchmark keeps
DATA = BENCH / "data"
WORKSPACE = uuid.UUID("00000000-0000-4000-8000-0000000be4c1")
BEFORE_COMMIT = "5b06898"
ARMS = ("before", "now")
RUNNER = Path(__file__).resolve().parent / "bench_runner.py"
FAULTS = ("missing_files", "unreadable_files", "jev_down", "llm_timeout", "writer_error")
CATEGORIES = {"fact": 10, "deep": 4, "topic": 4, "multi": 4, "followup": 3, "unanswerable": 5}  # per 30 cases
MISROUTED = {"off_topic", "chitchat", "about_app", "create", "external_action"}


def bench_env(cache: str) -> dict[str, str]:
    """The settings every process of the benchmark runs with: a local notebook, no production database, no traces."""
    return {
        "STORAGE_BACKEND": "local", "LOCAL_STORAGE_DIR": str(DATA / "storage"), "R2_PREFIX": "",
        "CORPUS_CACHE_DIR": str(DATA / cache), "DATABASE_URL": f"sqlite:///{DATA / 'bench.db'}",
        "LANGFUSE_PUBLIC_KEY": "", "LANGFUSE_SECRET_KEY": "", "CHAT_ANSWER_CACHE_DAYS": "0",
        "RUN_WORKER_IN_API": "false",
    }


DATA.mkdir(parents=True, exist_ok=True)
os.environ.update(bench_env("cache-main"))
sys.path.insert(0, str(BACKEND))

import chat_eval  # noqa: E402  (scripts/chat_eval.py: question writers, the pairwise judge, statistics)
import dspy  # noqa: E402
import numpy as np  # noqa: E402

from app.config import settings  # noqa: E402
from app.corpus import Corpus, post_path, render_post  # noqa: E402
from app.llm import provider  # noqa: E402
from app.pipeline import prefetch as pf  # noqa: E402

POSTS_FILE = DATA / "posts.json"
HOLDOUT_FILE = DATA / "holdout.jsonl"
QUESTIONS_FILE = BENCH / "questions.csv"
Q_FIELDS = ("id", "group", "case", "category", "wording", "turn", "scored", "question", "reference_answer",
            "gold_paths", "gold_lines", "gold_snippets")


def say(msg: str) -> None:
    print(msg, flush=True)


# build-corpus

WIKI_REPO, WIKI_FILE = "wikimedia/wikipedia", "20231101.simple/train-00000-of-00001.parquet"
WIKI_MARKUP = re.compile(r"^(\||\{\{|\}\}|\{\||!|thumb\||[\w ]{1,40}=\s)")
SKIP_HEADINGS = {"references", "related pages", "other websites", "notes", "sources", "further reading",
                 "external links", "bibliography", "gallery"}


def wiki_articles(min_chars: int, max_chars: int) -> list[dict]:
    import pyarrow.parquet as pq
    from huggingface_hub import hf_hub_download

    say(f"Downloading {WIKI_REPO}/{WIKI_FILE} (once; cached under .bench/hf) ...")
    path = hf_hub_download(WIKI_REPO, WIKI_FILE, repo_type="dataset", cache_dir=str(BACKEND / ".bench" / "hf"))  # shared by every bench dir
    out = []
    for batch in pq.ParquetFile(path).iter_batches(columns=["title", "text", "url"], batch_size=5000):
        for row in batch.to_pylist():
            text, title = row["text"] or "", row["title"] or ""
            if not (min_chars <= len(text) <= max_chars) or title.lower().startswith("list of"):
                continue
            if "may refer to" in text[:400] or "can mean" in text[:200]:
                continue
            out.append({"title": title, "text": text, "url": row["url"] or ""})
    return out


def dir_articles(root: Path, min_chars: int, max_chars: int) -> list[dict]:
    out = []
    for f in sorted(list(root.rglob("*.md")) + list(root.rglob("*.txt"))):
        text = f.read_text("utf-8", errors="ignore")
        if not (min_chars <= len(text) <= max_chars):
            continue
        m = re.search(r"(?m)^#\s+(.+)$", text)
        out.append({"title": m.group(1).strip() if m else f.stem.replace("-", " "), "text": text, "url": ""})
    return out


def sections_of(text: str) -> list[tuple[str | None, str]]:
    """Plain article text as (heading, body) sections: a short line with no end punctuation is a heading."""
    sections, heading, buf = [], None, []
    for block in re.split(r"\n+", text):
        b = block.strip()
        if not b or b.startswith("#") and len(b) < 3:
            continue
        b = b.lstrip("#").strip() if b.startswith("#") else b
        if WIKI_MARKUP.match(b):  # infobox and template lines: "| image = x.jpg", "{{...}}", "thumb|..."
            continue
        if len(b) < 70 and not re.search(r"[.!?:;\"')\]]$", b):
            if buf:
                sections.append((heading, "\n\n".join(buf)))
            heading, buf = b, []
        else:
            buf.append(b)
    if buf:
        sections.append((heading, "\n\n".join(buf)))
    return [(h, t) for h, t in sections if not (h and h.lower() in SKIP_HEADINGS)]


def build_corpus(args) -> None:
    if POSTS_FILE.exists() and not args.rebuild:
        posts = json.loads(POSTS_FILE.read_text("utf-8"))
        say(f"The benchmark notebook exists ({len(posts)} posts); --rebuild to make it again.")
    else:
        if args.rebuild:
            for p in (DATA / "storage", *DATA.glob("cache-*")):
                shutil.rmtree(p, ignore_errors=True)
        articles = (dir_articles(Path(args.source_dir), args.min_chars, args.max_chars) if args.source_dir
                    else wiki_articles(args.min_chars, args.max_chars))
        need = args.posts + args.holdout
        if len(articles) < need:
            sys.exit(f"Only {len(articles)} articles of {args.min_chars}-{args.max_chars} characters; need {need}")
        rng = random.Random(args.seed)
        picked = rng.sample(articles, need)
        holdout, chosen = picked[:args.holdout], picked[args.holdout:]
        corpus = Corpus(WORKSPACE)
        posts: dict[str, str] = {}
        files: dict[str, str] = {}
        first_day = datetime(2019, 1, 1)
        for art in chosen:
            published = first_day + timedelta(days=rng.randrange(0, 7 * 365))
            path = post_path("wikipedia", art["title"], art["url"], published)
            if path in posts:
                continue
            posts[path] = art["title"]
            files[path] = render_post(title=art["title"], url=art["url"], published_at=published, source="wikipedia",
                                      sections=sections_of(art["text"]) or [(None, art["text"])])
            if len(files) >= 200:
                corpus.write_files(files)
                files = {}
                say(f"  wrote {len(posts)} posts")
        if files:
            corpus.write_files(files)
        POSTS_FILE.write_text(json.dumps(posts, indent=0, ensure_ascii=False), "utf-8")
        with open(HOLDOUT_FILE, "w", encoding="utf-8") as f:
            for art in holdout:
                f.write(json.dumps(art, ensure_ascii=False) + "\n")
        (DATA / "corpus.json").write_text(json.dumps({"posts": len(posts), "holdout": len(holdout), "seed": args.seed,
                                                      "source": args.source_dir or f"{WIKI_REPO}/{WIKI_FILE}"}))
        say(f"Notebook: {len(posts)} posts, {len(holdout)} held-out articles (never in the notebook)")
    if args.no_cards:
        return
    from app.pipeline import cards as cards_mod

    provider.configure_default()
    corpus = Corpus(WORKSPACE)
    cards_mod.MAX_PARALLEL = args.card_workers
    settings.llm_max_concurrent = max(settings.llm_max_concurrent, args.card_workers)
    made = [0]
    lock = threading.Lock()
    real = cards_mod.make_card

    def make_card(title, text):
        card = real(title, text)
        with lock:
            made[0] += 1
            if made[0] % 50 == 0:
                say(f"  {made[0]} post cards made")
        return card

    cards_mod.make_card = make_card
    say(f"Post cards for the 'now' version ({args.card_workers} at a time; existing cards are kept) ...")
    t = time.perf_counter()
    result = cards_mod.build_cards(corpus, posts)
    say(f"Post cards: {result} in {time.perf_counter() - t:.0f}s")


# make-questions


class WriteTopicQuestion(dspy.Signature):
    """A writer keeps an archive of posts. Write one question they might ask to find what their archive says about
    the main subject of this post, phrased as if they don't remember the title: describe the subject in plain words
    and do not copy the title's words (e.g. "what have I got on that orange bridge in San Francisco?"). Then a one or
    two sentence answer summarising what the post says, from the post only. Leave both empty if the post has no clear
    subject."""

    post_title: str = dspy.InputField()
    post_start: str = dspy.InputField()
    question: str = dspy.OutputField()
    answer: str = dspy.OutputField()


class WriteMultiQuestion(dspy.Signature):
    """Write one question a writer might ask their archive that needs BOTH passages (from two different posts) to
    answer: for example comparing or combining a specific fact from each. Name both subjects. Then the short correct
    answer, using both passages. Leave both empty if no sensible question joins them."""

    title_a: str = dspy.InputField()
    passage_a: str = dspy.InputField()
    title_b: str = dspy.InputField()
    passage_b: str = dspy.InputField()
    question: str = dspy.OutputField()
    answer: str = dspy.OutputField(desc="One to three sentences, only from the passages")


class WriteFollowUp(dspy.Signature):
    """Write a two-turn chat a writer might have with an assistant about one post in their archive. first_question
    asks about a specific fact in passage A and names the subject. follow_up asks about a specific fact in passage B
    and refers back to the same subject with "it", "that", "they" and so on instead of naming it, so it only makes
    sense after the first question. Give the short correct answer to each, from its passage only. Leave everything
    empty if the passages hold nothing worth asking about."""

    post_title: str = dspy.InputField()
    passage_a: str = dspy.InputField()
    passage_b: str = dspy.InputField()
    first_question: str = dspy.OutputField()
    first_answer: str = dspy.OutputField()
    follow_up: str = dspy.OutputField()
    follow_up_answer: str = dspy.OutputField()


def allocate(cases: int) -> dict[str, int]:
    """Cases per category: the 30-case mix scaled, every category at least once when there is room."""
    if cases < len(CATEGORIES):
        order = ["fact", "unanswerable", "followup", "topic", "multi", "deep"]
        return {c: int(c in order[:cases]) for c in CATEGORIES}
    total = sum(CATEGORIES.values())
    raw = {c: w * cases / total for c, w in CATEGORIES.items()}
    out = {c: max(1, int(v)) for c, v in raw.items()}
    while sum(out.values()) < cases:
        out[max(raw, key=lambda c: raw[c] - out[c])] += 1
    while sum(out.values()) > cases:
        out[max(out, key=lambda c: out[c])] -= 1
    return out


def text_of(p) -> str:
    return "\n".join(p.lines)


def snippet_of(p) -> str:
    """A distinctive piece of the passage (the start of its longest line), to check what reached the answer writer."""
    lines = [x.strip() for x in p.lines if len(x.strip()) >= 60 and not x.lstrip().startswith("#")]
    line = max(lines or [max(p.lines, key=len).strip()], key=len)
    out = ""
    for w in line.split():
        if len(out) + len(w) + 1 > 80:
            break
        out = f"{out} {w}".strip()
    return out


def predict(sig, **kw):
    try:
        with dspy.context(lm=provider.main_lm()):
            return dspy.Predict(sig)(**kw)
    except Exception as exc:
        say(f"    skipped: {type(exc).__name__}: {str(exc)[:120]}")
        return None


def reword(question: str, passage: str) -> str:
    out = predict(chat_eval.ParaphraseQuestion, question=question, passage=passage)
    para = ((out.paraphrase if out else "") or "").strip()
    return para if para and para.lower() != question.lower() else ""


def make_questions(args) -> None:
    provider.configure_default()
    if not POSTS_FILE.exists():
        sys.exit("No benchmark notebook yet: run build-corpus first")
    allowed: dict[str, str] = json.loads(POSTS_FILE.read_text("utf-8"))
    corpus = Corpus(WORKSPACE)
    manifest = corpus.sync()
    units = [p for p in pf._index(corpus, allowed, manifest).units if sum(len(x) for x in p.lines) >= 300]
    by_post: dict[str, list] = {}
    for p in units:
        by_post.setdefault(p.path, []).append(p)
    post_lines = {path: len(corpus.read_lines(path)) for path in by_post}
    post_chars = {path: sum(len(x) for x in corpus.read_lines(path)) for path in by_post}
    rng = random.Random(args.seed)
    quota = allocate(max(1, args.questions // 2))
    say(f"Cases: {quota} (each asked in its exact and reworded wording)")
    used: set[str] = set()
    cases: list[dict] = []

    def fresh_posts(pred=lambda path: True) -> list[str]:
        paths = [p for p in by_post if p not in used and pred(p)]
        rng.shuffle(paths)
        return paths

    def add(category, turns, reference, gold, rework_passage):
        """turns: [(question, scored)]; gold: [(passage, ...)] per post; the last turn is the one reworded."""
        n = len({r["case"] for r in cases}) + 1
        cid = f"c{n:02d}"
        last_q = turns[-1][0]
        reworded = reword(last_q, rework_passage)
        if not reworded:
            say(f"    no rewording for {cid}; dropped")
            return False
        snippets = [{"path": p.path, "text": snippet_of(p)} for p in gold]
        lines = {}
        for p in gold:
            a, b = lines.get(p.path, (p.start, p.end))
            lines[p.path] = (min(a, p.start), max(b, p.end))
        for wording, last in (("exact", last_q), ("reworded", reworded)):
            group = f"{cid}-{wording[0]}"
            asked = [*turns[:-1], (last, True)]
            for ti, (q, scored) in enumerate(asked, start=1):
                cases.append({
                    "id": group if ti == len(asked) else f"{group}-t{ti}", "group": group, "case": cid,
                    "category": category, "wording": wording, "turn": ti, "scored": int(scored), "question": q,
                    "reference_answer": reference if scored else "",
                    "gold_paths": ";".join(lines) if scored else "",
                    "gold_lines": ";".join(f"{a}-{b}" for a, b in lines.values()) if scored else "",
                    "gold_snippets": json.dumps(snippets if scored else []),
                })
        for p in gold:
            used.add(p.path)
        say(f"  {cid} {category:12} {last_q}\n      ~ {reworded}")
        return True

    def single(category, need, pick):
        made = 0
        for path in fresh_posts():
            if made >= need:
                break
            p = pick(path)
            if p is None:
                continue
            out = predict(chat_eval.WriteQuestion, post_title=p.title, passage=text_of(p))
            q, a = ((out.question or "").strip(), (out.answer or "").strip()) if out else ("", "")
            if q and a and add(category, [(q, True)], a, [p], text_of(p)):
                made += 1

    # fact: any passage; deep: a passage in the second half of a long post
    single("fact", quota["fact"], lambda path: rng.choice(by_post[path]))

    def deep_pick(path):
        if post_chars[path] < 8000:
            return None
        late = [p for p in by_post[path] if p.start > post_lines[path] / 2]
        return rng.choice(late) if late else None

    single("deep", quota["deep"], deep_pick)

    made = 0
    for path in fresh_posts():  # topic: the post as a whole, asked about without its title
        if made >= quota["topic"]:
            break
        start = "\n".join(corpus.read_lines(path))[:3000]
        out = predict(WriteTopicQuestion, post_title=allowed[path], post_start=start)
        q, a = ((out.question or "").strip(), (out.answer or "").strip()) if out else ("", "")
        if q and a and add("topic", [(q, True)], f"The post '{allowed[path]}': {a}", by_post[path][:3], start):
            made += 1

    made = 0
    for path in fresh_posts():  # multi: two related posts (the second found by searching the first's title)
        if made >= quota["multi"]:
            break
        a_p = rng.choice(by_post[path])
        found = pf.prefetch(corpus, allowed, manifest, allowed[path])
        b_p = next((p for _, p in found.passages if p.path != path and p.path not in used and p.path in by_post), None)
        if b_p is None:
            continue
        out = predict(WriteMultiQuestion, title_a=a_p.title, passage_a=text_of(a_p), title_b=b_p.title,
                      passage_b=text_of(b_p))
        q, ans = ((out.question or "").strip(), (out.answer or "").strip()) if out else ("", "")
        if q and ans and add("multi", [(q, True)], ans, [a_p, b_p], text_of(a_p) + "\n\n" + text_of(b_p)):
            made += 1

    made = 0
    for path in fresh_posts(lambda p: len(by_post[p]) >= 2):  # follow up: two turns about one post
        if made >= quota["followup"]:
            break
        a_p, b_p = rng.sample(by_post[path], 2)
        out = predict(WriteFollowUp, post_title=a_p.title, passage_a=text_of(a_p), passage_b=text_of(b_p))
        if not out:
            continue
        q1, q2, a2 = ((out.first_question or "").strip(), (out.follow_up or "").strip(),
                      (out.follow_up_answer or "").strip())
        if q1 and q2 and a2 and add("followup", [(q1, False), (q2, True)], a2, [b_p], text_of(b_p)):
            made += 1

    # unanswerable: from an article that is not in the notebook, about a subject no post mentions
    holdout = [json.loads(x) for x in HOLDOUT_FILE.read_text("utf-8").splitlines() if x.strip()]
    rng.shuffle(holdout)
    everything = "\n".join("\n".join(corpus.read_lines(p)) for p in allowed).lower()
    made = 0
    for art in holdout:
        if made >= quota["unanswerable"]:
            break
        if len(art["title"]) < 4 or art["title"].lower() in everything:
            continue
        paras = [x.strip() for x in art["text"].split("\n") if 300 <= len(x.strip()) <= 1500]
        if not paras:
            continue
        passage = max(paras, key=len)
        out = predict(chat_eval.WriteQuestion, post_title=art["title"], passage=passage)
        q, a = ((out.question or "").strip(), (out.answer or "").strip()) if out else ("", "")
        if not q or not a:
            continue
        keys = {w.lower() for w in re.findall(r"\b(?:[A-Z][a-zA-Z]{2,}|\d{2,})\b", a)}
        if len(keys) >= 2 and any(all(k in body for k in keys) for body in everything.split("\n# ")):
            continue  # the notebook may hold this after all

        reference = f"The notebook does not cover this (it is from an article that is not in it: {a})"
        if add("unanswerable", [(q, True)], reference, [], passage):
            made += 1

    QUESTIONS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(QUESTIONS_FILE, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=Q_FIELDS)
        w.writeheader()
        w.writerows(cases)
    scored = sum(int(r["scored"]) for r in cases)
    say(f"Wrote {scored} scored questions ({len({r['case'] for r in cases})} cases x 2 wordings) to "
        f"{QUESTIONS_FILE}. Read them and delete bad rows (a whole group: every row with the same 'group').")


def read_questions(path: Path) -> list[dict]:
    rows = []
    with open(path, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if not (r.get("question") or "").strip():
                continue
            r["scored"] = bool(int(r.get("scored") or 1))
            r["turn"] = int(r.get("turn") or 1)
            r["gold_paths"] = [p for p in (r.get("gold_paths") or "").split(";") if p]
            r["gold_lines_list"] = [tuple(int(x) for x in g.split("-")) for g in (r.get("gold_lines") or "").split(";")
                                    if re.fullmatch(r"\d+-\d+", g)]
            r["gold_snippets"] = json.loads(r.get("gold_snippets") or "[]")
            rows.append(r)
    return rows


# run


class Runner:
    """One version of the chat in its own process (bench_runner.py), answering one chat per call."""

    def __init__(self, arm: str, app_root: Path, env: dict[str, str], log_dir: Path, timeout: float):
        self.arm, self.app_root, self.env, self.timeout = arm, app_root, env, timeout
        self.log = open(log_dir / f"runner-{arm}.log", "a", encoding="utf-8")
        self.proc: subprocess.Popen | None = None
        self.start()

    def start(self) -> None:
        cmd = [sys.executable, str(RUNNER), "--app-root", str(self.app_root), "--arm", self.arm,
               "--workspace", str(WORKSPACE), "--posts", str(POSTS_FILE), "--question-timeout", str(self.timeout)]
        self.proc = subprocess.Popen(cmd, cwd=BACKEND, env=self.env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=self.log, text=True, bufsize=1)
        info = self.call({"cmd": "info"})
        app_file = str(Path(info.get("app_file", "")).resolve())
        if not app_file.startswith(str(self.app_root.resolve())):
            raise RuntimeError(f"{self.arm}: imported app from {app_file}, not from {self.app_root}")
        say(f"  {self.arm}: {info}")

    def call(self, cmd: dict) -> dict:
        assert self.proc and self.proc.stdin and self.proc.stdout
        self.proc.stdin.write(json.dumps(cmd, default=str) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError(f"the {self.arm} runner stopped; see {self.log.name}")
        return json.loads(line)

    def ask(self, rows: list[dict], fault: str | None = None) -> list[dict]:
        clean = [{k: v for k, v in r.items() if k != "gold_lines_list"} for r in rows]
        try:
            return self.call({"cmd": "ask", "rows": clean, "fault": fault})["results"]
        except Exception as exc:  # the process died: record it as a crash of this chat and start a new one
            say(f"    {self.arm} runner died ({exc}); restarting")
            with_err = [{"arm": self.arm, "id": r["id"], "case": r.get("case", ""), "fault": fault or "",
                         "question": r["question"], "answer": "", "kind": "error", "path": "error",
                         "unsupported": True, "citations": [], "first_text_s": 0, "total_s": 0, "model_calls": 0,
                         "error_type": "RunnerCrashed", "error": str(exc)[:300], "scored": r.get("scored", True),
                         "evidence_hit": None} for r in rows]
            self.close()
            self.start()
            return with_err

    def close(self) -> None:
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.stdin.write('{"cmd": "quit"}\n')
                self.proc.stdin.flush()
                self.proc.wait(timeout=20)
            except Exception:
                self.proc.kill()


def worktree(commit: str) -> Path:
    path = BENCH / "before"
    if path.exists():
        head = subprocess.run(["git", "-C", str(path), "rev-parse", "HEAD"], capture_output=True, text=True).stdout
        if head.startswith(subprocess.run(["git", "-C", str(REPO), "rev-parse", commit], capture_output=True,
                                          text=True).stdout.strip()[:7]):
            return path / "backend"
        subprocess.run(["git", "-C", str(REPO), "worktree", "remove", "--force", str(path)], check=False)
    subprocess.run(["git", "-C", str(REPO), "worktree", "add", "--detach", str(path), commit], check=True,
                   capture_output=True)
    return path / "backend"


def remove_worktree() -> None:
    path = BENCH / "before"
    if path.exists():
        subprocess.run(["git", "-C", str(REPO), "worktree", "remove", "--force", str(path)], check=False)


def run(args) -> Path:
    rows = read_questions(Path(args.questions))
    if not rows:
        sys.exit(f"No questions in {args.questions}: run make-questions first")
    out = Path(args.resume) if args.resume else BENCH / "results" / datetime.now().strftime("%Y%m%d-%H%M%S")
    out.mkdir(parents=True, exist_ok=True)
    shutil.copy(args.questions, out / "questions.csv")
    runs_file = out / "runs.jsonl"
    done = set()
    if runs_file.exists():
        for line in runs_file.read_text("utf-8").splitlines():
            r = json.loads(line)
            done.add((r["arm"], r["id"], r.get("fault", "")))
    groups: dict[str, list[dict]] = {}
    for r in rows:
        groups.setdefault(r["group"], []).append(r)
    for g in groups.values():
        g.sort(key=lambda r: r["turn"])
    keep = list(dict.fromkeys(r["case"] for r in rows))[:args.limit] if args.limit else None
    if keep:
        groups = {k: g for k, g in groups.items() if g[0]["case"] in keep}

    say(f"Checking out {args.before_commit} for 'before' ...")
    before_root = worktree(args.before_commit)
    base = {**os.environ}
    env_before = {**base, **bench_env("cache-before")}
    env_now = {**base, **bench_env("cache-now"), "CHAT_ROUTER": "true" if args.now_router == "on" else "false"}
    for env in (env_before, env_now):
        env.pop("PYTHONPATH", None)
    meta = {"started": datetime.now().isoformat(timespec="seconds"), "before_commit": args.before_commit,
            "now_commit": subprocess.run(["git", "-C", str(REPO), "rev-parse", "--short", "HEAD"], capture_output=True,
                                         text=True).stdout.strip(),
            "now_router": args.now_router, "posts": len(json.loads(POSTS_FILE.read_text("utf-8"))),
            "groups": len(groups), "faults": not args.no_faults}
    (out / "meta.json").write_text(json.dumps(meta, indent=1))
    say(f"Starting both versions (results in {out}) ...")
    runners = {"before": Runner("before", before_root, env_before, out, args.question_timeout),
               "now": Runner("now", BACKEND, env_now, out, args.question_timeout)}

    def record(results: list[dict]) -> None:
        with open(runs_file, "a", encoding="utf-8") as f:
            for r in results:
                f.write(json.dumps(r, default=str) + "\n")

    try:
        # Cold start: the first question of each version builds its index over the whole notebook.
        warm = {"id": "warmup", "group": "warmup", "case": "warmup", "question": "What did I write about rivers?",
                "scored": False, "gold_snippets": [], "gold_paths": []}
        for arm, runner in runners.items():
            if (arm, "warmup", "") not in done:
                res = runner.ask([warm])
                record(res)
                say(f"  cold start {arm}: {res[0]['total_s']:.1f}s")
        todo = [(gi, g) for gi, g in enumerate(groups.values())]
        total = len(todo) * 2
        n = 0
        for gi, g in todo:
            for arm in (ARMS if gi % 2 == 0 else ARMS[::-1]):  # alternate who goes first
                n += 1
                if (arm, g[-1]["id"], "") in done:
                    continue
                res = runners[arm].ask(g)
                record(res)
                last = res[-1]
                say(f"  [{n:3d}/{total}] {arm:6} {last['id']:9} {last['path'][:16]:16} first "
                    f"{last['first_text_s']:6.1f}s total {last['total_s']:6.1f}s  "
                    f"evidence {last['evidence_hit']!s:5} {last.get('error_type', '')}")
        if not args.no_faults:
            picks = [g for g in groups.values() if g[0]["category"] == "fact" and g[0]["wording"] == "exact"][:3]
            say(f"Fault suite: {len(FAULTS)} faults x {len(picks)} questions x 2 versions")
            for fi, fault in enumerate(FAULTS):
                for gi, g in enumerate(picks):
                    for arm in (ARMS if (fi + gi) % 2 == 0 else ARMS[::-1]):
                        if (arm, g[-1]["id"], fault) in done:
                            continue
                        res = runners[arm].ask(g, fault)
                        record(res)
                        last = res[-1]
                        say(f"  {fault:16} {arm:6} {last['id']:9} hits {last.get('fault_hits', 0)} "
                            f"{last['total_s']:6.1f}s {last.get('error_type') or 'no exception'}")
    finally:
        for r in runners.values():
            r.close()
        if not args.keep_worktree:
            remove_worktree()
    if not args.no_judge:
        judge(argparse.Namespace(results=str(out), workers=args.judge_workers))
    report(argparse.Namespace(results=str(out)))
    return out


# judge


class GradeAnswer(dspy.Signature):
    """Grade an answer from a research assistant that must answer only from the user's notebook of posts.
    verdict: "correct" = states the reference answer's key facts (different wording and extra correct detail are
    fine); "partial" = some of the key facts, or so hedged it barely answers; "incorrect" = wrong, or about something
    else; "refused" = says the notebook does not cover it / could not find it, without answering.
    When the reference says the notebook does not cover the question, a refusal is "refused" and any substantive
    answer to the question is "incorrect".
    hallucinated: true when the answer states facts that are in neither the cited passages nor the reference."""

    question: str = dspy.InputField()
    reference_answer: str = dspy.InputField()
    answer: str = dspy.InputField()
    cited_passages: str = dspy.InputField()
    verdict: Literal["correct", "partial", "incorrect", "refused"] = dspy.OutputField()
    hallucinated: bool = dspy.OutputField()
    reason: str = dspy.OutputField(desc="One sentence")


def quotes_of(run: dict) -> list[str]:
    return [f"{c['path']} lines {c['line_start']}-{c['line_end']}: {c['quote']}" for c in run.get("citations", [])]


def grade(q: dict, run: dict) -> dict:
    if run.get("error_type") and not run.get("answer"):
        return {"verdict": "error", "hallucinated": False, "reason": run.get("error", "")[:200]}
    try:
        with dspy.context(lm=provider.main_lm("high")):
            out = dspy.Predict(GradeAnswer)(question=q["question"], reference_answer=q["reference_answer"],
                                            answer=run.get("answer") or "(no answer)",
                                            cited_passages="\n\n".join(quotes_of(run))[:20000] or "(none)")
        return {"verdict": out.verdict, "hallucinated": bool(out.hallucinated), "reason": (out.reason or "")[:300]}
    except Exception as exc:
        return {"verdict": "", "hallucinated": False, "reason": f"judge failed: {type(exc).__name__}"}


def judge(args) -> None:
    provider.configure_default()
    out = Path(args.results)
    qs = {r["id"]: r for r in read_questions(out / "questions.csv")}
    runs = [json.loads(x) for x in (out / "runs.jsonl").read_text("utf-8").splitlines() if x.strip()]
    gfile, pfile = out / "grades.jsonl", out / "pairwise.jsonl"
    have = {(g["arm"], g["id"], g["fault"]) for g in map(json.loads, gfile.read_text("utf-8").splitlines())} \
        if gfile.exists() else set()
    todo = [r for r in runs if r.get("scored") and r["id"] in qs and (r["arm"], r["id"], r.get("fault", "")) not in have]
    say(f"Grading {len(todo)} answers ...")
    lock = threading.Lock()

    def one(r):
        g = {"arm": r["arm"], "id": r["id"], "fault": r.get("fault", ""), **grade(qs[r["id"]], r)}
        with lock, open(gfile, "a", encoding="utf-8") as f:
            f.write(json.dumps(g) + "\n")

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        list(ex.map(one, todo))
    have_p = {p["id"] for p in map(json.loads, pfile.read_text("utf-8").splitlines())} if pfile.exists() else set()
    main = {(r["arm"], r["id"]): r for r in runs if r.get("scored") and not r.get("fault") and r["id"] in qs}
    ids = [i for i in qs if qs[i]["scored"] and ("before", i) in main and ("now", i) in main and i not in have_p]
    say(f"Head to head (both orders) on {len(ids)} questions ...")

    def pair(i):
        q = qs[i]
        old = {"mode": "old", "answer": main[("before", i)]["answer"], "quotes": quotes_of(main[("before", i)])}
        new = {"mode": "new", "answer": main[("now", i)]["answer"], "quotes": quotes_of(main[("now", i)])}
        res, _ = chat_eval.judge_question({"id": i, "question": q["question"], "expected_fact": "",
                                           "reference_answer": q["reference_answer"]}, old, new)
        winner = {"old": "before", "new": "now"}.get(res.get("judge_winner"), res.get("judge_winner") or "")
        with lock, open(pfile, "a", encoding="utf-8") as f:
            f.write(json.dumps({"id": i, "winner": winner, "consistent": res.get("judge_consistent"),
                                "reason": res.get("judge_reason", "")}) + "\n")

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        list(ex.map(pair, ids))


# report


def cite_hit(q: dict, run: dict) -> bool | None:
    if not q["gold_paths"]:
        return None
    cites = run.get("citations", [])
    if q["category"] in ("topic", "multi"):  # each gold post cited somewhere
        return all(any(c["path"] == p for c in cites) for p in q["gold_paths"])
    return any(c["path"] == p and c["line_start"] <= b and a <= c["line_end"]
               for p, (a, b) in zip(q["gold_paths"], q["gold_lines_list"], strict=False) for c in cites)


def assess(q: dict, run: dict, g: dict | None) -> dict:
    """Everything the report counts about one answer."""
    answerable = q["category"] != "unanswerable"
    verdict = (g or {}).get("verdict") or ""
    errored = bool(run.get("error_type"))
    timeout = "timeout" in (run.get("error_type") or "").lower()
    refused = verdict == "refused" or (not verdict and run.get("unsupported"))
    judged = verdict not in ("", "error") or errored
    correct = (verdict == "correct") if answerable else (verdict == "refused")
    if errored and not run.get("answer"):
        correct = False
    ch = cite_hit(q, run)
    strict = bool(correct and (ch if answerable else True))
    hallucinated = (not refused and not errored) if not answerable else bool((g or {}).get("hallucinated"))
    cause = ""
    if not correct:
        if timeout:
            cause = "timeout"
        elif errored:
            cause = "error"
        elif not answerable:
            cause = "hallucination"
        elif run.get("kind") in MISROUTED:
            cause = "misrouted"
        elif run.get("evidence_hit") is False:
            cause = "retrieval_miss"
        elif refused:
            cause = "false_refusal"
        else:
            cause = "wrong_answer" if verdict == "incorrect" else "incomplete"
    return {"answerable": answerable, "verdict": verdict, "judged": judged, "correct": correct,
            "partial_ok": correct or verdict == "partial", "strict": strict, "cite_hit": ch,
            "evidence_hit": run.get("evidence_hit"), "refused": bool(refused), "hallucinated": hallucinated,
            "errored": errored, "timeout": timeout, "cause": cause}


def pct(xs: list) -> float | None:
    xs = [x for x in xs if x is not None]
    return round(100 * sum(bool(x) for x in xs) / len(xs), 1) if xs else None


def quantile(xs: list[float], q: float) -> float | None:
    xs = sorted(x for x in xs if x is not None)
    return round(float(np.percentile(xs, q)), 2) if xs else None


def mcnemar(before: list[bool], now: list[bool]) -> float | None:
    from scipy.stats import binomtest
    b = sum(1 for x, y in zip(before, now, strict=True) if x and not y)
    c = sum(1 for x, y in zip(before, now, strict=True) if y and not x)
    return round(float(binomtest(min(b, c), b + c, 0.5).pvalue), 4) if b + c else None


def report(args) -> None:
    out = Path(args.results)
    meta = json.loads((out / "meta.json").read_text()) if (out / "meta.json").exists() else {}
    qs = {r["id"]: r for r in read_questions(out / "questions.csv")}
    runs = [json.loads(x) for x in (out / "runs.jsonl").read_text("utf-8").splitlines() if x.strip()]
    grades = {}
    if (out / "grades.jsonl").exists():
        for g in map(json.loads, (out / "grades.jsonl").read_text("utf-8").splitlines()):
            grades[(g["arm"], g["id"], g["fault"])] = g
    pairs = {}
    if (out / "pairwise.jsonl").exists():
        pairs = {p["id"]: p for p in map(json.loads, (out / "pairwise.jsonl").read_text("utf-8").splitlines())}
    have_judge = bool(grades)

    main: dict[tuple[str, str], dict] = {}
    for r in runs:
        if r.get("scored") and not r.get("fault") and r["id"] in qs:
            main[(r["arm"], r["id"])] = {**r, **assess(qs[r["id"]], r, grades.get((r["arm"], r["id"], "")))}
    ids = sorted(i for i in qs if ("before", i) in main and ("now", i) in main)
    if not ids:
        sys.exit("No question was answered by both versions yet")
    cold = {r["arm"]: r["total_s"] for r in runs if r["id"] == "warmup"}

    def col(arm, key, sel=lambda q: True):
        return [main[(arm, i)][key] for i in ids if sel(qs[i])]

    ans = lambda q: q["category"] != "unanswerable"  # noqa: E731
    unans = lambda q: q["category"] == "unanswerable"  # noqa: E731

    summary: list[dict] = []

    def rate(name, key, sel=lambda q: True, higher=True, needs_judge=False):
        if needs_judge and not have_judge:
            return
        b, n = col("before", key, sel), col("now", key, sel)
        pairs_ = [(x, y) for x, y in zip(b, n, strict=True) if x is not None and y is not None]
        if not pairs_:
            return
        diffs = [100 * (int(bool(y)) - int(bool(x))) for x, y in pairs_]
        lo, hi = chat_eval.bootstrap(diffs, lambda xs: float(np.mean(xs)))
        summary.append({"metric": name, "unit": "%", "before": pct([x for x, _ in pairs_]),
                        "now": pct([y for _, y in pairs_]), "change": round(float(np.mean(diffs)), 1),
                        "ci_low": lo, "ci_high": hi, "p_value": mcnemar([bool(x) for x, _ in pairs_],
                                                                         [bool(y) for _, y in pairs_]),
                        "n": len(pairs_), "better": "higher" if higher else "lower"})

    def latency(name, key, q_):
        b, n = col("before", key), col("now", key)
        summary.append({"metric": name, "unit": "s", "before": quantile(b, q_), "now": quantile(n, q_),
                        "change": round(quantile(n, q_) - quantile(b, q_), 2), "ci_low": "", "ci_high": "",
                        "p_value": chat_eval.wilcoxon_p(b, n) if q_ == 50 else "", "n": len(b), "better": "lower"})

    rate("Correct answers", "correct", needs_judge=True)
    rate("Correct or partly correct", "partial_ok", needs_judge=True)
    rate("Correct response (correct + cites the right post)", "strict", needs_judge=True)
    rate("Evidence recall (right passage reached the writer)", "evidence_hit", ans)
    rate("Cites the right lines", "cite_hit", ans)
    rate("False refusals (answer was in the notebook)", "refused", ans, higher=False)
    rate("Hallucinated on unanswerable questions", "hallucinated", unans, higher=False)
    rate("Errors (exception or crash)", "errored", higher=False)
    rate("Timeouts", "timeout", higher=False)
    for key, label in (("first_text_s", "Time to first text"), ("total_s", "Total time")):
        for q_ in (50, 90, 95):
            latency(f"{label} p{q_}", key, q_)
        summary.append({"metric": f"{label} max", "unit": "s", "before": max(col("before", key)),
                        "now": max(col("now", key)), "change": round(max(col("now", key)) - max(col("before", key)), 2),
                        "ci_low": "", "ci_high": "", "p_value": "", "n": len(ids), "better": "lower"})
    b_t, n_t = col("before", "total_s"), col("now", "total_s")
    lo, hi = chat_eval.bootstrap(list(zip(b_t, n_t, strict=True)),
                                 lambda ps: float(np.median([x for x, _ in ps]) / max(np.median([y for _, y in ps]),
                                                                                     1e-9)))
    summary.append({"metric": "Speed-up, total time (median before / median now)", "unit": "x",
                    "before": "", "now": "", "change": round(statistics.median(b_t) / max(statistics.median(n_t), 1e-9), 2),
                    "ci_low": lo, "ci_high": hi, "p_value": "", "n": len(ids), "better": "higher"})
    for key, label in (("first_text_s", "first text"), ("total_s", "answer")):
        b5 = [x <= 5 for x in col("before", key)]
        n5 = [x <= 5 for x in col("now", key)]
        summary.append({"metric": f"Questions with {label} within 5 s", "unit": "%", "before": pct(b5), "now": pct(n5),
                        "change": round(pct(n5) - pct(b5), 1), "ci_low": "", "ci_high": "",
                        "p_value": mcnemar(b5, n5), "n": len(ids), "better": "higher"})
    for key, label in (("model_calls", "Model calls per question"), ("prompt_tokens", "Prompt tokens per question"),
                       ("completion_tokens", "Completion tokens per question")):
        b, n = [x or 0 for x in col("before", key)], [x or 0 for x in col("now", key)]
        summary.append({"metric": label + " (median)", "unit": "", "before": statistics.median(b),
                        "now": statistics.median(n), "change": statistics.median(n) - statistics.median(b),
                        "ci_low": "", "ci_high": "", "p_value": chat_eval.wilcoxon_p(b, n), "n": len(ids),
                        "better": "lower"})
    if cold:
        summary.append({"metric": "Cold start (first question, builds the index)", "unit": "s",
                        "before": cold.get("before"), "now": cold.get("now"),
                        "change": round((cold.get("now") or 0) - (cold.get("before") or 0), 2), "ci_low": "",
                        "ci_high": "", "p_value": "", "n": 1, "better": "lower"})
    wins = [pairs[i]["winner"] for i in ids if i in pairs and pairs[i]["winner"]]
    if wins:
        decided = [1.0 if w == "now" else 0.0 for w in wins if w in ARMS]
        lo, hi = chat_eval.bootstrap(decided, lambda xs: float(np.mean(xs))) if decided else ("", "")
        summary.append({"metric": "Head to head: now wins (of decided)", "unit": "%", "before": wins.count("before"),
                        "now": wins.count("now"), "change": round(100 * float(np.mean(decided)), 1) if decided else "",
                        "ci_low": round(100 * lo, 1) if lo != "" else "", "ci_high": round(100 * hi, 1) if hi != "" else "",
                        "p_value": "", "n": len(wins), "better": "higher",
                        "note": f"before/now columns count wins; {wins.count('tie')} ties"})

    # breakdowns
    def table(dim: str) -> list[dict]:
        rows_ = []
        for value in dict.fromkeys(qs[i][dim] for i in ids):
            sel = [i for i in ids if qs[i][dim] == value]
            row = {dim: value, "n": len(sel)}
            for arm in ARMS:
                m = [main[(arm, i)] for i in sel]
                row[f"{arm}_correct"] = pct([x["correct"] for x in m]) if have_judge else None
                row[f"{arm}_strict"] = pct([x["strict"] for x in m]) if have_judge else None
                row[f"{arm}_evidence"] = pct([x["evidence_hit"] for x in m])
                row[f"{arm}_refused"] = pct([x["refused"] for x in m])
                row[f"{arm}_median_s"] = quantile([x["total_s"] for x in m], 50)
            rows_.append(row)
        return rows_

    by_category, by_wording = table("category"), table("wording")
    causes = {arm: {} for arm in ARMS}
    for (arm, _), m in main.items():
        if m["cause"]:
            causes[arm][m["cause"]] = causes[arm].get(m["cause"], 0) + 1

    faults_rows = []
    for fault in FAULTS:
        for arm in ARMS:
            fr = [r for r in runs if r.get("fault") == fault and r["arm"] == arm and r.get("scored") and r["id"] in qs]
            if not fr:
                continue
            a = [assess(qs[r["id"]], r, grades.get((arm, r["id"], fault))) for r in fr]
            faults_rows.append({"fault": fault, "arm": arm, "runs": len(fr),
                                "triggered": sum(1 for r in fr if r.get("fault_hits")),
                                "crashed": sum(x["errored"] for x in a),
                                "graceful": sum(not x["errored"] and not x["correct"] for x in a),
                                "recovered": sum(x["correct"] for x in a) if have_judge else None,
                                "median_s": quantile([r["total_s"] for r in fr], 50)})

    per_q = []
    for i in ids:
        q = qs[i]
        row = {"id": i, "case": q["case"], "category": q["category"], "wording": q["wording"],
               "question": q["question"], "reference": q["reference_answer"]}
        for arm in ARMS:
            m = main[(arm, i)]
            g = grades.get((arm, i, ""), {})
            row.update({f"{arm}_verdict": m["verdict"], f"{arm}_correct": m["correct"], f"{arm}_strict": m["strict"],
                        f"{arm}_evidence_hit": m["evidence_hit"], f"{arm}_cite_hit": m["cite_hit"],
                        f"{arm}_cause": m["cause"], f"{arm}_path": m["path"], f"{arm}_total_s": m["total_s"],
                        f"{arm}_first_text_s": m["first_text_s"], f"{arm}_model_calls": m.get("model_calls"),
                        f"{arm}_judge_reason": g.get("reason", ""), f"{arm}_answer": m["answer"]})
        row["head_to_head"] = pairs.get(i, {}).get("winner", "")
        row["head_to_head_reason"] = pairs.get(i, {}).get("reason", "")
        per_q.append(row)
    failures = []
    for (arm, i), m in sorted(main.items()):
        if m["cause"]:
            failures.append({"arm": arm, "id": i, "category": qs[i]["category"], "wording": qs[i]["wording"],
                             "cause": m["cause"], "verdict": m["verdict"],
                             "judge_reason": grades.get((arm, i, ""), {}).get("reason", ""),
                             "question": qs[i]["question"], "reference": qs[i]["reference_answer"],
                             "answer": m["answer"], "path": m["path"], "error": m.get("error", ""),
                             "evidence_excerpt": (m.get("evidence") or "")[:1500]})

    def write(name, data):
        if not data:
            return
        keys = list(dict.fromkeys(k for d in data for k in d))
        with open(out / name, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=keys)
            w.writeheader()
            w.writerows(data)

    write("summary.csv", summary)
    write("per_question.csv", per_q)
    write("failures.csv", failures)
    write("faults.csv", faults_rows)
    write("by_category.csv", by_category)
    write("by_wording.csv", by_wording)
    (out / "report.html").write_text(render_html(meta, summary, by_category, by_wording, causes, faults_rows, per_q,
                                                 have_judge, len(ids)), "utf-8")
    say("\nSummary (summary.csv has the confidence intervals):")
    for s in summary:
        ci = f"  95% CI [{s['ci_low']}, {s['ci_high']}]" if s["ci_low"] != "" else ""
        p = f"  p={s['p_value']}" if s["p_value"] not in ("", None) else ""
        say(f"  {s['metric'][:52]:52} before {s['before']!s:>8}  now {s['now']!s:>8}  change {s['change']!s:>7}{ci}{p}")
    say(f"\nFailure causes: {causes}")
    say(f"Report: {out / 'report.html'}")


# report.html

CSS = """
:root{--bg:#f7f7f5;--card:#fff;--ink:#1d1d1b;--muted:#6b6b66;--line:#e3e2dd;--good:#1f7a4d;--bad:#b3261e;
--before:#8a8a84;--now:#2f5fd0;--chip:#efeee9}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#151514;--card:#1e1e1c;--ink:#ecebe6;
--muted:#a3a29b;--line:#33322f;--good:#5cc28d;--bad:#ff7a6e;--before:#9a9993;--now:#7ea2ff;--chip:#2a2a27}}
:root[data-theme="dark"]{--bg:#151514;--card:#1e1e1c;--ink:#ecebe6;--muted:#a3a29b;--line:#33322f;--good:#5cc28d;
--bad:#ff7a6e;--before:#9a9993;--now:#7ea2ff;--chip:#2a2a27}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,
Segoe UI,Roboto,sans-serif}main{max-width:1080px;margin:0 auto;padding:28px 16px 64px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:18px;margin:36px 0 10px}.muted{color:var(--muted)}
.verdict{font-size:17px;margin:14px 0 22px;padding:14px 16px;background:var(--card);border:1px solid var(--line);
border-radius:10px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}
.card .k{font-size:13px;color:var(--muted)}.card .v{font-size:24px;font-weight:650;margin-top:4px}
.card .d{font-size:13px;margin-top:2px}.good{color:var(--good)}.bad{color:var(--bad)}
.wrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{padding:8px 10px;border-bottom:1px solid var(--line);
text-align:left;vertical-align:top}th{font-weight:600;color:var(--muted);font-size:12.5px;white-space:nowrap}
td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}tr:last-child td{border-bottom:0}
.bar{display:flex;align-items:center;gap:8px;margin:3px 0}.bar span.l{width:140px;font-size:13px;color:var(--muted)}
.bar i{display:block;height:12px;border-radius:3px}.bar b{font-weight:500;font-size:13px}
.chip{display:inline-block;padding:1px 7px;border-radius:99px;background:var(--chip);font-size:12px}
details{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:8px 0}
summary{cursor:pointer}pre{white-space:pre-wrap;font:13px/1.45 ui-monospace,Menlo,monospace;margin:6px 0}
.legend{font-size:13px;color:var(--muted)}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;
margin:0 4px 0 10px}
"""


def fmt(v, unit=""):
    if v is None or v == "":
        return "–"
    if isinstance(v, float):
        v = round(v, 2)
    return f"{v}{'%' if unit == '%' else ('s' if unit == 's' else ('x' if unit == 'x' else ''))}"


def render_html(meta, summary, by_category, by_wording, causes, faults_rows, per_q, have_judge, n) -> str:
    e = html.escape
    s = {r["metric"]: r for r in summary}

    def delta(r):
        if r["change"] in ("", None):
            return ""
        good = (r["change"] > 0) == (r["better"] == "higher") if r["change"] != 0 else None
        cls = "" if good is None else ("good" if good else "bad")
        unit = " pts" if r["unit"] == "%" else r["unit"]
        sign = "+" if r["change"] > 0 else ""
        p = f" · p={r['p_value']}" if r.get("p_value") not in ("", None) else ""
        return f'<span class="{cls}">{sign}{r["change"]}{unit}</span>{p}'

    def card(metric, label=None):
        r = s.get(metric)
        if not r:
            return ""
        return (f'<div class="card"><div class="k">{e(label or metric)}</div><div class="v">{fmt(r["now"], r["unit"])}'
                f'</div><div class="d muted">before {fmt(r["before"], r["unit"])} · {delta(r)}</div></div>')

    acc = s.get("Correct answers")
    if acc:
        word = "better" if acc["change"] > 0 else ("worse" if acc["change"] < 0 else "the same")
        sig = (" The difference is statistically significant (p < 0.05)." if isinstance(acc["p_value"], float)
               and acc["p_value"] < 0.05 else " With this many questions the difference is not yet statistically "
               "significant (p ≥ 0.05); it could be noise.")
        verdict = (f"The current chat answers <b>{fmt(acc['now'], '%')}</b> of questions correctly, against "
                   f"<b>{fmt(acc['before'], '%')}</b> before: {word} by {abs(acc['change'])} points.{sig}")
    else:
        verdict = "Answers were not judged (--no-judge), so accuracy is not available; retrieval and speed are below."
    t = s.get("Total time p50")
    if t:
        verdict += (f" Median time to the full answer: <b>{fmt(t['now'], 's')}</b> (before {fmt(t['before'], 's')}).")

    def ci(r):
        return "" if r["ci_low"] in ("", None) else f"[{r['ci_low']}, {r['ci_high']}]"

    rows = "".join(
        f"<tr><td>{e(r['metric'])}</td><td class=n>{fmt(r['before'], r['unit'])}</td><td class=n>"
        f"{fmt(r['now'], r['unit'])}</td><td class=n>{delta(r)}</td><td class=n>{ci(r)}</td><td class=n>{r['n']}</td></tr>"
        for r in summary)

    def breakdown(data, dim):
        head = "".join(f"<th>{a} {k}</th>" for k in ("correct", "evidence", "refused", "median") for a in ARMS)
        body = ""
        for r in data:
            cells = "".join(
                f"<td class=n>{fmt(r[f'{a}_{k}'], 's' if k == 'median_s' else '%')}</td>"
                for k in ("correct", "evidence", "refused", "median_s") for a in ARMS)
            body += f"<tr><td>{e(str(r[dim]))}</td><td class=n>{r['n']}</td>{cells}</tr>"
        return f'<div class="wrap"><table><tr><th>{dim}</th><th>n</th>{head}</tr>{body}</table></div>'

    all_causes = sorted({c for a in ARMS for c in causes[a]}, key=lambda c: -sum(causes[a].get(c, 0) for a in ARMS))
    top = max([causes[a].get(c, 0) for a in ARMS for c in all_causes] or [1])
    cause_html = "".join(
        f'<div class="bar"><span class="l">{e(c)}</span><div>'
        + "".join(f'<div class="bar"><i style="width:{max(2, 260 * causes[a].get(c, 0) / top):.0f}px;'
                  f'background:var(--{a})"></i><b>{causes[a].get(c, 0)}</b></div>' for a in ARMS)
        + "</div></div>" for c in all_causes) or "<p>No failures.</p>"
    cause_help = {
        "retrieval_miss": "the passage with the answer never reached the answer writer (search failed)",
        "false_refusal": "the right passage was there, but the chat said the notebook does not cover it",
        "wrong_answer": "the right passage was there, but the answer was wrong",
        "incomplete": "partly correct", "misrouted": "triage sent it away from the notebook (off topic, chit-chat)",
        "hallucination": "answered a question the notebook cannot answer", "error": "an exception",
        "timeout": "no answer in time"}
    help_html = "".join(f"<li><b>{e(k)}</b>: {e(v)}</li>" for k, v in cause_help.items() if k in all_causes)

    fault_html = "".join(
        f"<tr><td>{e(r['fault'])}</td><td>{r['arm']}</td><td class=n>{r['runs']}</td><td class=n>{r['triggered']}</td>"
        f"<td class=n>{r['crashed']}</td><td class=n>{r['graceful']}</td><td class=n>{fmt(r['recovered'])}</td>"
        f"<td class=n>{fmt(r['median_s'], 's')}</td></tr>" for r in faults_rows)

    def answer_block(r):
        parts = "".join(
            f"<p><b>{a}</b> <span class=chip>{e(str(r[f'{a}_verdict'] or '-'))}</span> "
            f"<span class=chip>{e(r[f'{a}_cause'] or 'ok')}</span> <span class=muted>{r[f'{a}_total_s']}s · "
            f"{e(str(r[f'{a}_path']))}</span></p><pre>{e((r[f'{a}_answer'] or '(no answer)')[:2500])}</pre>"
            f"<p class=muted>{e(r[f'{a}_judge_reason'])}</p>" for a in ARMS)
        return (f"<details><summary><b>{e(r['id'])}</b> · {e(r['category'])} · {e(r['wording'])} — "
                f"{e(r['question'])}</summary><p class=muted>Reference: {e(r['reference'])}</p>{parts}</details>")

    regressions = [r for r in per_q if r["before_correct"] and not r["now_correct"]]
    fixed = [r for r in per_q if r["now_correct"] and not r["before_correct"]]
    both_fail = [r for r in per_q if not r["now_correct"] and not r["before_correct"]]

    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Chat benchmark</title>
<style>{CSS}</style></head><body><main>
<h1>Notebook chat: before vs now</h1>
<p class="muted">{n} questions on a {meta.get('posts', '?')}-post notebook · before = {e(str(meta.get('before_commit')))}
· now = {e(str(meta.get('now_commit')))} (router {e(str(meta.get('now_router')))}) · {e(str(meta.get('started', '')))}</p>
<div class="verdict">{verdict}</div>
<div class="cards">
{card("Correct answers")}{card("Correct response (correct + cites the right post)", "Correct response (strict)")}
{card("Evidence recall (right passage reached the writer)", "Evidence recall")}
{card("False refusals (answer was in the notebook)", "False refusals")}
{card("Total time p50", "Median total time")}{card("Time to first text p50", "Median first text")}
{card("Errors (exception or crash)", "Errors")}{card("Hallucinated on unanswerable questions", "Hallucinated (unanswerable)")}
</div>
<h2>All metrics</h2>
<p class="legend">Change is now minus before (points for percentages). The 95% CI is a bootstrap over questions;
p-values: McNemar's exact test for yes/no metrics, Wilcoxon for times and counts.</p>
<div class="wrap"><table><tr><th>Metric</th><th>Before</th><th>Now</th><th>Change</th><th>95% CI</th><th>n</th></tr>
{rows}</table></div>
<h2>Why answers failed</h2>
<p class="legend">Failed answers by cause<i style="background:var(--before)"></i>before<i style="background:var(--now)">
</i>now</p>
<div class="wrap" style="padding:12px 14px">{cause_html}<ul class="muted" style="font-size:13px">{help_html}</ul></div>
<h2>By question type</h2>{breakdown(by_category, "category")}
<h2>Same wording vs reworded</h2>
<p class="legend">Reworded questions use other words than the post. A big gap means search depends on the post's exact
vocabulary.</p>{breakdown(by_wording, "wording")}
<h2>Error handling (fault suite)</h2>
<p class="legend">Each fault is injected for one question. crashed = an exception escaped; graceful = a clean message
or refusal; recovered = still answered correctly. triggered = the fault was actually hit.</p>
<div class="wrap"><table><tr><th>Fault</th><th>Version</th><th>Runs</th><th>Triggered</th><th>Crashed</th>
<th>Graceful</th><th>Recovered</th><th>Median</th></tr>{fault_html or '<tr><td colspan=8>Not run</td></tr>'}</table></div>
<h2>Fixed by the new chat ({len(fixed)})</h2>{''.join(answer_block(r) for r in fixed) or '<p class=muted>None</p>'}
<h2>Regressions: right before, wrong now ({len(regressions)})</h2>
{''.join(answer_block(r) for r in regressions) or '<p class=muted>None</p>'}
<h2>Still failing in both ({len(both_fail)})</h2>{''.join(answer_block(r) for r in both_fail) or '<p class=muted>None</p>'}
<p class="muted" style="margin-top:28px">Latency is measured in-process (research() only); the API adds its database
time on top. {'' if have_judge else 'Answers were not judged.'}</p>
</main></body></html>"""


def main() -> None:
    import logging
    logging.basicConfig(level=logging.ERROR)
    for name in ("LiteLLM", "litellm", "httpx", "dspy", "app"):
        logging.getLogger(name).setLevel(logging.ERROR)
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def corpus_args(p):
        p.add_argument("--posts", type=int, default=2000)
        p.add_argument("--holdout", type=int, default=40, help="articles kept out, for unanswerable questions")
        p.add_argument("--seed", type=int, default=7)
        p.add_argument("--min-chars", type=int, default=1500)
        p.add_argument("--max-chars", type=int, default=20000)
        p.add_argument("--source-dir", help="a folder of .md/.txt files to use instead of Wikipedia")
        p.add_argument("--rebuild", action="store_true", help="delete the benchmark notebook and build it again")
        p.add_argument("--no-cards", action="store_true")
        p.add_argument("--card-workers", type=int, default=8)

    def question_args(p):
        p.add_argument("--questions", type=int, default=60, help="scored questions: half exact, half reworded")
        if "--seed" not in p._option_string_actions:
            p.add_argument("--seed", type=int, default=7)

    def run_args(p):
        p.add_argument("--questions-file", dest="questions_path", default=str(QUESTIONS_FILE))
        p.add_argument("--limit", type=int, help="only the first N cases (a smoke test)")
        p.add_argument("--before-commit", default=BEFORE_COMMIT)
        p.add_argument("--now-router", choices=("on", "off"), default="on")
        p.add_argument("--no-faults", action="store_true")
        p.add_argument("--no-judge", action="store_true")
        p.add_argument("--judge-workers", type=int, default=4)
        p.add_argument("--question-timeout", type=float, default=240)
        p.add_argument("--resume", help="a results folder to continue (skips what it already holds)")
        p.add_argument("--keep-worktree", action="store_true")

    bc = sub.add_parser("build-corpus", help="build the benchmark notebook and its post cards")
    corpus_args(bc)
    mq = sub.add_parser("make-questions", help="write .bench/questions.csv")
    question_args(mq)
    rn = sub.add_parser("run", help="run both versions, judge, report")
    run_args(rn)
    jd = sub.add_parser("judge", help="(re)grade a results folder")
    jd.add_argument("--results", required=True)
    jd.add_argument("--workers", type=int, default=4)
    rp = sub.add_parser("report", help="rebuild the report of a results folder")
    rp.add_argument("--results", required=True)
    al = sub.add_parser("all", help="build-corpus, make-questions (unless they exist), run")
    corpus_args(al)
    question_args(al)
    run_args(al)
    al.add_argument("--new-questions", action="store_true", help="write new questions even if questions.csv exists")
    args = ap.parse_args()
    {"build-corpus": build_corpus, "make-questions": make_questions, "run": run_cmd, "judge": judge,
     "report": report, "all": all_cmd}[args.cmd](args)


def run_cmd(args) -> None:
    args.questions = args.questions_path
    run(args)


def all_cmd(args) -> None:
    build_corpus(args)
    if not QUESTIONS_FILE.exists() or args.new_questions:
        make_questions(args)
    args.questions = args.questions_path  # from here on, the questions file (make-questions used the count)
    run(args)


if __name__ == "__main__":
    main()
