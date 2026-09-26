"""Launch Kit: one post in, everything needed to launch it out, in the writer's voice and grounded in
the post's own claims."""

from sqlalchemy.orm import Session

from app.corpus import INDEX, Corpus
from app.llm import run
from app.llm.signatures import CarouselSlides, ExtractClaims, HookGenerator, PickQuotes, PlatformAdapter, SeoPack
from app.models import Artifact, Document, Job
from app.pipeline.generate import NothingToDo
from app.pipeline.passages import passages_for, tools_for, verify_refs, voice_text
from app.services.jobs import create_job, update_job

PLATFORMS = {
    "x_thread": ("X thread", "5 to 9 posts, each under 270 characters. Post 1 is the hook and stands alone. "
                 "No hashtags except at most one at the end. The last post links to the article with {url}."),
    "linkedin": ("LinkedIn", "One post, 900 to 1,500 characters. Short paragraphs of 1 to 2 lines. Open with a "
                 "concrete line, not a question. End with the link {url} and one question for comments."),
    "substack_notes": ("Substack Notes", "3 separate notes, each 1 to 4 sentences, conversational, each able "
                       "to stand alone. One of them links to {url}."),
    "bluesky": ("Bluesky", "A thread of 3 to 6 posts, each under 290 characters. Plain, human, no hashtags. "
                "The last post links to {url}."),
}


def build_launch_kit(db: Session, job: Job, artifact: Artifact) -> dict:
    doc = db.get(Document, artifact.document_id) if artifact.document_id else None
    if not doc or not doc.path:
        raise NothingToDo("Pick a post for the Launch Kit.")
    ws = artifact.workspace_id
    corpus = Corpus(ws)
    passages = passages_for(corpus, [doc], budget_chars=50_000)
    tools = tools_for(corpus, [doc])
    voice = voice_text(db, ws)
    url = doc.url if doc.url.startswith("http") else ""

    def step(progress: float, message: str) -> None:
        update_job(db, job, progress=progress, message=message)

    step(0.08, "Pulling out the key claims")
    claims_out = run.predict(ExtractClaims, db=db, workspace_id=ws, job=job, passages=passages)
    claims = []
    for c in claims_out.get("claims") or []:
        refs = verify_refs(tools, c.get("sources") or [])
        if refs and c.get("claim"):
            claims.append({"claim": c["claim"], "sources": refs})
    if not claims:
        raise RuntimeError("No verifiable claims found in this post")
    claim_inputs = [{"claim": c["claim"], "sources": [{k: s[k] for k in ("path", "line_start", "line_end")}
                                                      for s in c["sources"]]} for c in claims]

    step(0.2, "Writing hooks")
    hooks = run.predict(HookGenerator, db=db, workspace_id=ws, job=job, passages=passages,
                        voice_profile=voice, n=8).get("hooks") or []
    hooks = sorted(hooks, key=lambda h: -(h.get("strength") or 0))

    posts: dict[str, list[str]] = {}
    for i, (platform, (label, rules)) in enumerate(PLATFORMS.items()):
        step(0.3 + 0.1 * i, f"Adapting for {label}")
        out = run.predict(PlatformAdapter, db=db, workspace_id=ws, job=job, claims=claim_inputs, voice_profile=voice,
                          platform=platform, platform_rules=rules.format(url=url or "the post"))
        posts[platform] = [p for p in (out.get("posts") or []) if p.strip()]

    step(0.72, "Building the SEO pack")
    related = []
    if corpus.exists(INDEX):
        related = [ln for ln in corpus.read_lines(INDEX) if "|" in ln and doc.path not in ln][:150]
    seo = run.predict(SeoPack, db=db, workspace_id=ws, job=job, title=doc.title, passages=passages,
                      related_posts="\n".join(related)).get("seo") or {}

    step(0.82, "Designing the carousel")
    slides = run.predict(CarouselSlides, db=db, workspace_id=ws, job=job, passages=passages,
                         voice_profile=voice).get("slides") or []

    step(0.9, "Choosing quotes")
    quotes = []
    for pick in run.predict(PickQuotes, db=db, workspace_id=ws, job=job, passages=passages, n=3).get("quotes") or []:
        refs = verify_refs(tools, [pick.get("source") or {}])
        if refs and pick.get("quote"):
            quotes.append({"quote": pick["quote"][:380], "source": refs[0]})

    artifact.content_json = {
        **(artifact.content_json or {}),
        "title": f"Launch Kit: {doc.title}",
        "post_title": doc.title,
        "post_url": doc.url,
        "claims": claims,
        "hooks": hooks,
        "posts": posts,
        "seo": seo,
        "carousel": slides,
        "quotes": quotes,
    }
    artifact.status = "ready"
    db.commit()

    # Quote cards render as their own artifacts, so a missing renderer does not sink the kit.
    card_ids = []
    for q in quotes:
        card = Artifact(workspace_id=ws, document_id=doc.id, type="quote_card", status="pending",
                        content_json={"title": f"Quote: {doc.title}", "parent_id": str(artifact.id), **q})
        db.add(card)
        db.flush()
        create_job(db, ws, "quote_card", {"artifact_id": str(card.id)}, artifact_id=card.id, max_attempts=1)
        card_ids.append(str(card.id))
    artifact.content_json = {**artifact.content_json, "quote_card_ids": card_ids}
    db.commit()
    return {"artifact_id": str(artifact.id), "claims": len(claims)}
