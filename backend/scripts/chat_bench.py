"""Times the notebook chat against a running API: time to the first answer text, time to the verified answer, and how
many research steps each question took. Run it before and after a speed change, on the same notebook.

  python scripts/chat_bench.py --notebook <id> --token <bearer token> [--api http://localhost:8000]

The questions cover each path: a quick lookup (fast path), a deep question, a multi-part one (parallel parts), a
follow up that only reshapes the last answer (rewrite), and an exact repeat of the first question in a new chat
(answer cache). Pass --question several times to use your own instead. The server log's CHAT TRACE block for each
message says which path ran and why."""

import argparse
import json
import time

import httpx

QUESTIONS = [
    ("new", "What have I written about pricing?"),
    ("same", "make it shorter"),
    ("new", "How has my thinking changed over time across these posts?"),
    ("new", "Compare what I wrote about pricing, hiring and AI"),
    ("new", "Give me a detailed deep dive on my most important idea"),
    ("new", "tl;dr of my most recent post"),
    ("new", "What have I written about pricing?"),  # a repeat in a new chat: the answer cache
]


def ask(client: httpx.Client, api: str, notebook: str, question: str, chat_id: str | None) -> dict:
    start = time.perf_counter()
    first = answered = None
    steps = resets = 0
    new_chat = chat_id
    event = ""
    with client.stream("POST", f"{api}/api/notebooks/{notebook}/chat", json={"question": question, "chat_id": chat_id},
                       timeout=300) as res:
        res.raise_for_status()
        for line in res.iter_lines():
            if line.startswith("event: "):
                event = line[7:]
            elif line.startswith("data: "):
                data = json.loads(line[6:])
                now = time.perf_counter() - start
                if event == "status" and data.get("chat_id"):
                    new_chat = data["chat_id"]
                elif event == "step":
                    steps += 1
                elif event == "delta" and first is None:
                    first = now
                elif event == "reset":
                    resets += 1
                elif event == "answer":
                    answered = now
                    if first is None:
                        first = now
    return {"first": first, "answer": answered, "steps": steps, "resets": resets, "chat_id": new_chat}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--api", default="http://localhost:8000")
    ap.add_argument("--notebook", required=True)
    ap.add_argument("--token", required=True)
    ap.add_argument("--question", action="append", help="ask these instead, each in a new chat")
    args = ap.parse_args()
    plan = [("new", q) for q in args.question] if args.question else QUESTIONS
    headers = {"Authorization": f"Bearer {args.token}"}
    chat_id = None
    print(f"{'first text':>10}  {'answer':>8}  {'steps':>5}  {'resets':>6}  question")
    with httpx.Client(headers=headers) as client:
        for where, question in plan:
            out = ask(client, args.api, args.notebook, question, chat_id if where == "same" else None)
            chat_id = out["chat_id"]
            fmt = lambda s: f"{s:.1f}s" if s is not None else "-"  # noqa: E731
            print(f"{fmt(out['first']):>10}  {fmt(out['answer']):>8}  {out['steps']:>5}  {out['resets']:>6}  {question}")


if __name__ == "__main__":
    main()
