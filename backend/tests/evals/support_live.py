"""Read the help bot's real answers. Not a pytest test: it calls the live model (LLM_API_KEY) and prints what a writer
would see, so a person can judge it.

    cd backend && python -m tests.evals.support_live            # all questions
    python -m tests.evals.support_live "how do I add my blog"   # one question
"""

import asyncio
import sys
import time

from app.llm.postprocess import strip_em_dashes
from app.routers.support import _docs_block
from app.support import escalation as esc
from app.support import llm, prompts, scope
from app.support.retriever import get_retriever

# (question, what a good answer must do)
CASES = [
    ("How do I add my blog?", "numbered steps: Sources, paste link, Connect"),
    ("how do i connect my substack", "Sources page, Substack archive supported"),
    ("what file types can I upload?", "md, markdown, txt, html, pdf"),
    ("How do I make an audio overview?", "notebook Create tab, format and length"),
    ("What is in the free plan?", "1 source, 5 indexed posts, 3 min audio, 1 min video, 2 launch kits"),
    ("how much is the writer plan", "$24.99 monthly, $18.99 yearly"),
    ("Does voice cloning cost extra?", "on Writer and Studio, not Free"),
    ("how do I schedule a post to linkedin", "Launchpad, New post, connect LinkedIn"),
    ("why did I get an email instead of an auto post", "Substack Notes or unconnected platform sends a reminder"),
    ("can notestack make avatars of me", "says it does not; no invented feature"),
    ("is there a mobile app", "says main app is not optimised for mobile; no invented app"),
    ("does it integrate with zapier", "not in docs: unsure, offer to pass to team"),
    ("what's the capital of France", "one line redirect to Notestack"),
    ("is chatgpt better than notestack", "stays on Notestack, no competitor advice"),
    ("hi", "short friendly greeting"),
    ("what did I write about pricing?", "BLOCKED: cannot see their content, no model call"),
    ("summarize my notebook", "BLOCKED"),
    ("what did we talk about earlier?", "BLOCKED"),
    ("why did my video fail", "BLOCKED + offer human form"),
    ("I want to talk to a human", "hand off line, form, no false claims"),
    ("I want a refund", "hand off line, form"),
    ("will you ever add Ghost newsletters", "answer, plus feature request form"),
    ("how do I delete my account", "Settings > Account"),
    ("how do I start a new chat in a notebook", "notebook chat sidebar new chat button"),
    # reports, study tools, infographics, sharing, library
    ("how do I make a report", "Create panel > Report, Made from, format, template, Generate"),
    ("what's the difference between interactive and document reports", "interactive embeds visuals, document is text only"),
    ("what report templates are there", "Create Your Own, Briefing Doc, Study Guide, Blog Post, suggested"),
    ("can I edit the instructions before the report is written", "pencil / Next, edit instructions"),
    ("how do I add a mind map to my report", "interactive report, Suggested card, Add"),
    ("can I download a report", "Download Markdown on the report page"),
    ("how do I share a report with a friend who has no account", "Share, Create share link, Copy link"),
    ("can people see my posts if I share a report", "no: report only, no source text"),
    ("how do I stop sharing", "Share > Stop sharing, link ends"),
    ("share button says not allowed", "Settings > Privacy > Allow public report links"),
    ("can I share my quiz by link", "no: only reports and infographics"),
    ("how do I make a quiz", "Create > Quiz, made from, settings, Generate Quiz"),
    ("what question types can a quiz have", "multiple choice, multiple select, fill blank, short answer"),
    ("how do I make flashcards", "Create > Flashcards, Generate Flashcards"),
    ("how do I flip flashcards", "tap/Space, Got it, Review again, Shuffle"),
    ("where do I find my quizzes", "Library > Quizzes tab, or the Create panel"),
    ("where is the library", "left sidebar between Sources and Launchpad"),
    ("how do I make an infographic", "Create > Infographic, theme, Generate"),
    ("what infographic themes are there", "Launch, Galaxy, Solar System, Space Station, Moon Base, Observatory"),
    ("what is a mind constellation", "galaxy map of ideas, from posts"),
    ("how many reports can I make on the free plan", "2 a month"),
    ("is there a limit on infographics on the writer plan", "30 a month"),
    ("how do I make a quote card", "not in Create panel now; no invention"),
    ("can I make a podcast with more than two hosts", "no invention"),
    ("can I copy a chat answer", "Copy answer button, no [1] markers"),
    ("summarize my report", "BLOCKED"),
    ("what's in my quiz", "BLOCKED"),
]


async def run(question: str) -> None:
    print(f"\n=== {question}")
    if scope.about_user_data(question):
        reply, broken = scope.out_of_scope_reply(question)
        print(f"[blocked by scope gate, no model call; human form: {broken}]\n{reply}")
        return
    reason = esc.classify_question(question)
    started = time.perf_counter()
    if esc.should_short_circuit(reason):
        text = ""
        async for tok in llm.stream_answer(
            [{"role": "system", "content": esc.handoff_prompt(reason)}, {"role": "user", "content": question}]
        ):
            text += tok
        safe = esc.handoff_line_is_safe(text)
        reply = strip_em_dashes(text.strip()) if safe else esc.short_circuit_reply(reason)
        print(f"[hand off, reason={reason.value}, safe={safe}]\n{reply}")
        return
    scored = get_retriever().retrieve(question)
    system = prompts.ANSWER_PROMPT.format(docs=_docs_block(scored, question), user_context="USER CONTEXT: (none)", summary="(none)")
    text, first = "", None
    async for tok in llm.stream_answer([{"role": "system", "content": system}, {"role": "user", "content": question}]):
        first = first or time.perf_counter() - started
        text += tok
    meta = await llm.complete_meta(
        [{"role": "system", "content": prompts.META_PROMPT.format(doc_ids="\n".join(f"- {s.doc.id}: {s.doc.title}" for s in scored))},
         {"role": "user", "content": question}, {"role": "assistant", "content": text}]
    )
    escalate = esc.classify_answer(text) or (esc.Reason.FEATURE if reason is esc.Reason.FEATURE else None) or meta.escalate
    print(f"[docs: {[s.doc.id for s in scored]} | cited: {meta.citations} | form: {escalate and getattr(escalate, 'value', 'human')} | "
          f"first token {first or 0:.1f}s, total {time.perf_counter() - started:.1f}s]")
    print(strip_em_dashes(text.strip()))


async def main(questions: list[str]) -> None:
    print(f"model: {llm.model_name()}")
    for q in questions:
        try:
            await run(q)
        except llm.LLMError as exc:
            print(f"[model error: {exc}]")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1:] or [q for q, _ in CASES]))
