"""Worker: runs queued jobs from the Postgres jobs table plus scheduled email batches.

Run: python -m app.worker

- Claims jobs with FOR UPDATE SKIP LOCKED, runs up to WORKER_CONCURRENCY at once in threads.
- Failed jobs retry with backoff up to max_attempts; jobs whose worker died (no heartbeat for
  JOB_STALE_SECONDS) are requeued.
- Periodic tasks take a Postgres advisory lock, so with several workers only one runs each tick.
"""

import logging
import os
import signal
import socket
import threading
import time
import uuid
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime

import httpx
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.chat_memory.organize import forget_orphans, organize_chat, rebuild_chat
from app.config import settings
from app.db import SessionLocal, engine
from app.models import (
    Artifact,
    Chat,
    Document,
    Job,
    Message,
    Source,
    Subscription,
    UpdateEmail,
    UpdateEmailSend,
    Upload,
    User,
    VoiceConsent,
    VoiceProfile,
    Workspace,
    WorkspaceMember,
)
from app.pipeline import flashcards, generate, infographic, launchkit, media, quiz, report, slides
from app.pipeline.generate import NothingToDo
from app.pipeline.ingest import FeedNotFound, entry_from_upload, extract_article, ingest_source, store_entries
from app.pipeline.memory import learn_from_message
from app.services import launchpad, report_suggestions, tts, video_quota
from app.services.email import email_service
from app.services.email_verification import purge_old_codes
from app.services.jobs import (
    claim_next,
    create_job,
    pending_job,
    record_usage,
    retry_or_fail,
    stale_jobs,
    update_job,
)
from app.services.notestack_voices import save_notestack_voice
from app.services.plans import effective_plan, post_room
from app.services.renderer import PermanentJobError, request_render
from app.services.social.health import social_health
from app.services.storage import keys, storage
from app.services.uploads import sweep_orphan_uploads

log = logging.getLogger("notestack.worker")


@dataclass
class Done:
    result: dict = field(default_factory=dict)
    message: str = "Done"


HANDED_OFF = object()  # the job continues elsewhere (renderer) and reports back via callbacks


# Handlers: (db, job) -> Done | HANDED_OFF. Raise to trigger a retry.


def _after_import(db: Session, job: Job, workspace_id: uuid.UUID, changed: list[str]) -> None:
    """New or changed posts are mapped into the topic constellation and scored for resurfacing, and the
    first import builds the writing voice, so none of these need a button press."""
    if not changed or not settings.llm_api_key:
        return
    create_job(db, workspace_id, "topics", {"document_ids": changed}, max_attempts=2)
    create_job(db, workspace_id, "ideas", {"document_ids": changed}, max_attempts=2)
    if not pending_job(db, workspace_id, "resurface_scan"):
        create_job(db, workspace_id, "resurface_scan", {}, max_attempts=2)
    vp = db.scalar(select(VoiceProfile).where(VoiceProfile.workspace_id == workspace_id))
    if not (vp and vp.profile_json) and not pending_job(db, workspace_id, "voice_profile"):
        create_job(db, workspace_id, "voice_profile", {"document_ids": []}, max_attempts=2)


def handle_ingest(db: Session, job: Job):
    source = db.get(Source, uuid.UUID(job.params["source_id"]))
    if not source:
        return Done({"error": "source deleted"}, "Source no longer exists")
    plan = effective_plan(db, db.get(Workspace, source.workspace_id))
    # The plan limit is one total across every source, link and upload: this source gets what the others leave.
    room = post_room(db, source.workspace_id, plan, source.id)
    try:
        result = ingest_source(db, source, job, max_posts=room)
    except Exception as exc:
        db.rollback()
        source.sync_status = "error"
        source.sync_error = str(exc)[:500]
        db.commit()
        if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code in (401, 403, 404, 410):
            raise PermanentJobError(f"The feed returned {exc.response.status_code}.") from exc
        if isinstance(exc, FeedNotFound):
            raise PermanentJobError(str(exc)) from exc
        raise
    _after_import(db, job, source.workspace_id, result.get("changed", []))
    if result.get("locked"):
        return Done(result, f"Found {result['found']} posts. Your latest {result['available']} are indexed; "
                            f"upgrade to index the other {result['locked']}")
    return Done(result, f"All posts in orbit: {result['indexed']} new or updated")


def handle_memory(db: Session, job: Job):
    """Decide whether the writer's chat message holds a lasting note, and update their memory."""
    msg = db.get(Message, uuid.UUID(job.params["message_id"]))
    chat = db.get(Chat, msg.chat_id) if msg else None
    if not msg or msg.role != "user" or not chat or chat.workspace_id != job.workspace_id:
        return Done({"saved": []}, "Message no longer exists")
    result = learn_from_message(db, job, job.workspace_id, msg.content)
    return Done(result, "Notes updated" if result["saved"] else "Nothing to save")


def handle_chat_memory(db: Session, job: Job):
    """File a chat's new rounds under topics (summary, keywords, exact quotes) in the notebook's chat memory."""
    chat = db.get(Chat, uuid.UUID(job.params["chat_id"]))
    if not chat or chat.workspace_id != job.workspace_id:
        return Done({"rounds": 0}, "Chat no longer exists")
    result = organize_chat(db, job, chat)
    return Done(result, f"Filed {result['rounds']} rounds" if result["rounds"] else "Nothing new to file")


def handle_chat_memory_rebuild(db: Session, job: Job):
    """Rebuild chat memory from the messages. Params: notebook_id, and optionally chat_id for just one chat."""
    notebook_id = uuid.UUID(job.params["notebook_id"])
    chats = db.scalars(select(Chat).where(Chat.notebook_id == notebook_id, Chat.workspace_id == job.workspace_id))
    only = job.params.get("chat_id")
    done = [rebuild_chat(db, job, c) for c in chats if not only or str(c.id) == only]
    return Done({"chats": len(done), "rounds": sum(d["rounds"] for d in done)}, f"Rebuilt {len(done)} chats")


def handle_chat_memory_cleanup(db: Session, job: Job):
    """Remove chat memory whose chat is gone. Params: notebook_id."""
    removed = forget_orphans(db, job.workspace_id, uuid.UUID(job.params["notebook_id"]))
    return Done({"removed": removed}, f"Removed {removed} orphaned chats")


def _require_room(db: Session, source: Source, url: str) -> None:
    """Re-reading a post that is already indexed is fine; a new one needs room under the plan's post limit."""
    known = db.scalar(select(Document.id).where(Document.source_id == source.id, Document.url == url,
                                                 Document.path.is_not(None)))
    plan = effective_plan(db, db.get(Workspace, source.workspace_id))
    if not known and post_room(db, source.workspace_id, plan) <= 0:
        raise PermanentJobError(f"Your plan indexes up to {plan.indexed_posts} posts, and they are all used. "
                                "Remove a post or upgrade to add more.")


def handle_import_url(db: Session, job: Job):
    source = db.get(Source, uuid.UUID(job.params["source_id"]))
    update_job(db, job, progress=0.1, message="Fetching the article")
    try:
        entry = extract_article(job.params["url"])
    except FeedNotFound as exc:
        raise PermanentJobError(str(exc)) from exc
    _require_room(db, source, entry.url)
    indexed, _, changed = store_entries(db, source, [entry])
    _after_import(db, job, source.workspace_id, [str(i) for i in changed])
    return Done({"indexed": indexed, "document_ids": [str(i) for i in changed]}, f"{entry.title[:80]} is in orbit")


def handle_import_upload(db: Session, job: Job):
    source = db.get(Source, uuid.UUID(job.params["source_id"]))
    upload = db.get(Upload, uuid.UUID(job.params["upload_id"]))
    update_job(db, job, progress=0.1, message=f"Reading {upload.filename}")
    entry = entry_from_upload(upload.filename, upload.content_type, storage.get_bytes(upload.key))
    if not entry.sections and not entry.html:
        raise PermanentJobError("We could not read any text in that file.")
    _require_room(db, source, entry.url)
    indexed, _, changed = store_entries(db, source, [entry])
    _after_import(db, job, source.workspace_id, [str(i) for i in changed])
    return Done({"indexed": indexed, "document_ids": [str(i) for i in changed]}, f"{entry.title[:80]} is in orbit")


def handle_topics(db: Session, job: Job):
    return Done(generate.extract_topics(db, job, job.workspace_id, job.params.get("document_ids")), "Topic map ready")


def handle_ideas(db: Session, job: Job):
    result = generate.extract_ideas(db, job, job.workspace_id, job.params.get("document_ids"))
    if result["extracted"]:
        report_suggestions.queue_warmup(db, job.workspace_id)  # their notebooks' suggested report templates are written now
    return Done(result, f"Read {result['extracted']} posts for their ideas")


def handle_report_templates(db: Session, job: Job):
    written = report_suggestions.warm_workspace(db, job.workspace_id)
    return Done({"written": written}, f"Prepared report templates for {written} notebooks")


def handle_voice_profile(db: Session, job: Job):
    try:
        result = generate.build_voice_profile(db, job, job.workspace_id, job.params.get("document_ids") or [])
    except NothingToDo as exc:
        raise PermanentJobError(str(exc)) from exc
    return Done(result, "Voice profile ready")


def handle_voice_clone(db: Session, job: Job):
    consent = db.get(VoiceConsent, uuid.UUID(job.params["consent_id"]))
    if not consent or consent.revoked_at:
        return Done({}, "Consent was revoked")
    sample_keys = job.params.get("sample_keys") or [consent.sample_key]
    update_job(db, job, progress=0.15, message=f"Sending {len(sample_keys)} recording(s) to ElevenLabs")
    samples = []
    for key in sample_keys:
        head = storage.head(key) or {}
        samples.append((key.rsplit("/", 1)[-1], storage.get_bytes(key), head.get("ContentType") or "audio/webm"))
    owner = db.get(User, consent.user_id)
    try:
        voice_id = tts.clone_voice(f"{(owner.name if owner and owner.name else 'My')} (Notestack)", samples,
                                   remove_background_noise=bool(job.params.get("remove_background_noise", True)))
    except tts.TTSError as exc:
        raise PermanentJobError(str(exc)) from exc
    consent.elevenlabs_voice_id = voice_id
    db.commit()

    # Save the new voice to the workspace's voices (and keep it as the default host A), then record a short preview
    # so the writer can judge it straight away.
    update_job(db, job, progress=0.7, message="Recording a preview in your voice")
    vp = db.scalar(select(VoiceProfile).where(VoiceProfile.workspace_id == consent.workspace_id))
    if not vp:
        vp = VoiceProfile(workspace_id=consent.workspace_id)
        db.add(vp)
    vp.host_voices = {**(vp.host_voices or {}), "host_a": voice_id}
    save_notestack_voice(db, consent.workspace_id, voice_id, "My voice")
    db.commit()
    preview_text = job.params.get("preview_text") or (
        "Hi, this is my Notestack voice. From now on, my audio overviews and videos can sound like me.")
    preview_key = None
    try:
        clip = tts.synthesize(consent.workspace_id, preview_text[:600], voice_id)
        preview_key = storage.put_bytes(keys.artifact(consent.workspace_id, consent.id, "voice-preview", "mp3"),
                                        clip, "audio/mpeg")
        record_usage(db, workspace_id=consent.workspace_id, kind="tts", provider="elevenlabs",
                     quantity=round(tts.mp3_seconds(clip), 1), unit="seconds", job=job)
    except tts.TTSError:
        log.warning("voice preview failed for %s", voice_id, exc_info=True)
    return Done({"voice_id": voice_id, "preview_key": preview_key}, "Your voice is ready and set as host A")


def handle_resurface(db: Session, job: Job):
    return Done(generate.score_evergreen(db, job, job.workspace_id), "Evergreen scores updated")


def _artifact_handler(fn: Callable[[Session, Job, Artifact], object], done_message: str):
    def handler(db: Session, job: Job):
        artifact = db.get(Artifact, uuid.UUID(job.params["artifact_id"]))
        if not artifact:
            return Done({}, "Artifact was deleted")
        artifact.status = "generating"
        db.commit()
        try:
            result = fn(db, job, artifact)
        except (NothingToDo, tts.TTSError) as exc:
            raise PermanentJobError(str(exc)) from exc
        if result is None:
            return HANDED_OFF  # the renderer reports back through /api/internal/jobs/{id}/progress
        return Done(result if isinstance(result, dict) else {}, done_message)

    return handler


def handle_render(db: Session, job: Job):
    """Direct render of caller supplied props (POST /api/artifacts/{id}/render)."""
    artifact = db.get(Artifact, uuid.UUID(job.params["artifact_id"]))
    update_job(db, job, progress=0.01, message="T-minus: preparing render")
    request_render(job, artifact, job.params["composition"], job.params.get("props") or {})
    return HANDED_OFF


def handle_publish_post(db: Session, job: Job):
    item = launchpad.publish_job(db, job.params["item_id"])
    return Done({"status": item.status if item else "gone"}, "Published" if item and item.status == "posted"
                else f"Post {item.status}" if item else "Post deleted")


HANDLERS: dict[str, Callable[[Session, Job], object]] = {
    "ingest": handle_ingest,
    "import_url": handle_import_url,
    "import_upload": handle_import_upload,
    "topics": handle_topics,
    "publish_post": handle_publish_post,
    "ideas": handle_ideas,
    "report_templates": handle_report_templates,
    "memory_update": handle_memory,
    "chat_memory": handle_chat_memory,
    "chat_memory_rebuild": handle_chat_memory_rebuild,
    "chat_memory_cleanup": handle_chat_memory_cleanup,
    "voice_profile": handle_voice_profile,
    "voice_clone": handle_voice_clone,
    "resurface_scan": handle_resurface,
    "summary": _artifact_handler(generate.summarize_notebook, "Summary ready"),
    "mind_map": _artifact_handler(generate.build_mind_map, "Mind Constellation ready"),
    "quiz": _artifact_handler(quiz.build_quiz, "Quiz ready"),
    "flashcards": _artifact_handler(flashcards.build_flashcards, "Flashcards ready"),
    "report": _artifact_handler(report.build_report, "Report ready"),
    "infographic": _artifact_handler(infographic.build_infographic, "Infographic ready"),
    "slide_deck": _artifact_handler(slides.build_slide_deck, "Slide deck ready"),
    "report_block": report.handle_report_block,
    "audio_overview": _artifact_handler(media.audio_overview, "Audio overview ready"),
    "video": _artifact_handler(media.make_video, "Audiogram ready"),  # audiograms; videos come from blog2video
    "quote_card": _artifact_handler(media.make_quote_card, "Quote card ready"),
    "carousel": _artifact_handler(media.render_carousel, "Carousel ready"),
    "launch_kit": _artifact_handler(launchkit.build_launch_kit, "Launch Kit ready"),
    "render": handle_render,
}


def mark_artifact_failed(db: Session, job: Job, error: str) -> None:
    # A failed "add a visual" job leaves the report as it was; the job's own error tells the page what went wrong.
    if job.artifact_id and job.kind != "report_block":
        artifact = db.get(Artifact, job.artifact_id)
        if artifact:
            artifact.status = "failed"
            artifact.content_json = {**(artifact.content_json or {}), "error": error[:500]}
            db.commit()


def run_job(
    job_id: uuid.UUID,
    session_factory: Callable[[], Session] = SessionLocal,
    handlers: dict | None = None,
) -> None:
    handlers = handlers or HANDLERS
    with session_factory() as db:
        job = db.get(Job, job_id)
        if not job:
            return
        handler = handlers.get(job.kind)
        if not handler:
            update_job(db, job, status="failed", error=f"No handler for job kind {job.kind!r}")
            return
        try:
            outcome = handler(db, job)
        except PermanentJobError as exc:
            db.rollback()
            job = db.get(Job, job_id)
            update_job(db, job, status="failed", error=str(exc), message=str(exc)[:500])
            mark_artifact_failed(db, job, str(exc))
            return
        except Exception as exc:
            # Roll back first: after a failed flush, touching `job` raises PendingRollbackError.
            db.rollback()
            job = db.get(Job, job_id)
            log.exception("job %s (%s) attempt %s failed", job_id, job.kind, job.attempts)
            if not retry_or_fail(db, job, f"{type(exc).__name__}: {exc}"):
                mark_artifact_failed(db, job, f"{type(exc).__name__}: {exc}")
            return
        if outcome is HANDED_OFF:
            return
        done = outcome if isinstance(outcome, Done) else Done()
        update_job(db, job, status="done", progress=1.0, message=done.message, result=done.result)


def recover_stale(session_factory: Callable[[], Session] = SessionLocal) -> int:
    with session_factory() as db:
        jobs = stale_jobs(db)
        for job in jobs:
            log.warning("job %s stale (worker %s), requeueing", job.id, job.locked_by)
            retry_or_fail(db, job, "Worker stopped responding")
        db.commit()
        return len(jobs)


# Periodic tasks


@contextmanager
def single_flight(name: str):
    """Postgres advisory lock on a dedicated connection; yields False if another worker holds it."""
    if engine.dialect.name != "postgresql":
        yield True
        return
    with engine.connect() as conn:
        got = conn.execute(text("SELECT pg_try_advisory_lock(hashtext(:n))"), {"n": name}).scalar()
        try:
            yield bool(got)
        finally:
            if got:
                conn.execute(text("SELECT pg_advisory_unlock(hashtext(:n))"), {"n": name})
                conn.commit()


def topics_backfill(session_factory: Callable[[], Session] = SessionLocal) -> None:
    """Every indexed post gets topics: one whose tagging failed (the model timed out, rate limited, answered nothing)
    or that came before posts were tagged on import is asked for again here, one topics job per workspace that has
    some, unless one is already queued. A post that keeps failing stops being asked (generate.MAX_TAG_FAILURES)."""
    if not settings.llm_api_key:
        return
    with session_factory() as db:
        rows = db.execute(select(Document.workspace_id, Document.metadata_json).where(Document.path.is_not(None)))
        for workspace_id in {ws for ws, meta in rows if generate.needs_topics(meta)}:
            if not pending_job(db, workspace_id, "topics"):
                create_job(db, workspace_id, "topics", {}, max_attempts=2)


def update_email_batch(session_factory: Callable[[], Session] = SessionLocal) -> None:
    """Sends one daily batch per scheduled campaign at its send hour (UTC)."""
    now = datetime.now(UTC)
    with session_factory() as db:
        campaigns = db.scalars(select(UpdateEmail).where(UpdateEmail.status.in_(["scheduled", "running"]))).all()
        for campaign in campaigns:
            hour = campaign.send_hour if campaign.send_hour >= 0 else settings.update_email_send_hour
            if now.hour != hour:
                continue
            if campaign.last_batch_at and campaign.last_batch_at.date() == now.date():
                continue
            already = select(UpdateEmailSend.user_id).where(UpdateEmailSend.update_email_id == campaign.id)
            q = select(User).where(
                User.is_active.is_(True), User.email_unsubscribed.is_(False), User.id.not_in(already)
            )
            if campaign.user_filter != "all":
                plans = {"paid": ["writer", "studio"]}.get(campaign.user_filter, [campaign.user_filter])
                q = (
                    q.join(WorkspaceMember, WorkspaceMember.user_id == User.id)
                    .join(Subscription, Subscription.workspace_id == WorkspaceMember.workspace_id)
                    .where(Subscription.plan.in_(plans))
                )
            users = db.scalars(q.limit(campaign.batch_size)).unique().all()
            campaign.status = "running"
            for user in users:
                ok = email_service.send_blast_email(
                    str(user.id), user.email, user.name, campaign.subject, campaign.body
                )
                db.add(UpdateEmailSend(update_email_id=campaign.id, user_id=user.id, status="sent" if ok else "failed"))
                campaign.sent_count += int(ok)
                campaign.failed_count += int(not ok)
            campaign.total_users = campaign.sent_count + campaign.failed_count
            campaign.last_batch_at = now
            if len(users) < campaign.batch_size:
                campaign.status = "completed"
            db.commit()


def daily_cleanup(session_factory: Callable[[], Session] = SessionLocal) -> None:
    with session_factory() as db:
        purge_old_codes(db)
    sweep_orphan_uploads(session_factory)  # upload files whose record was deleted, and unfinished uploads


@dataclass
class Periodic:
    name: str
    every_seconds: float
    fn: Callable[[], object]
    next_at: float = 0.0
    # Run on the wall clock's multiples of every_seconds (1800: at :00 and :30 UTC), not every_seconds after the last
    # run. The first run is still at start-up, to catch up on anything already due.
    align: bool = False

    def schedule_next(self, now: float, wall: float | None = None) -> None:
        if not self.align:
            self.next_at = now + self.every_seconds
            return
        wall = time.time() if wall is None else wall
        # A couple of seconds past the boundary, so a post scheduled exactly on it is already due.
        self.next_at = now + (self.every_seconds - wall % self.every_seconds) + ALIGN_GRACE_SECONDS


ALIGN_GRACE_SECONDS = 2

PERIODIC = [
    Periodic("recover_stale", 60, recover_stale),
    # Posts are scheduled on half hours (in the user's zone), so they go out on the :00 / :30 run. Zones on a :45
    # offset (Nepal) get slots between runs: those go out at the next run, up to 15 minutes late.
    Periodic("publish_due", 1800, launchpad.publish_due, align=True),
    Periodic("social_health", 600, social_health),
    Periodic("sync_engagement", 3600, launchpad.sync_engagement),
    Periodic("update_email_batch", 300, update_email_batch),
    Periodic("topics_backfill", 900, topics_backfill),
    Periodic("daily_cleanup", 24 * 3600, daily_cleanup),
    Periodic("video_period_reset", 3600, video_quota.reset_due_video_periods),
    Periodic("video_refund_sweep", 600, video_quota.sweep_failed_videos),
    Periodic("video_capacity_check", 3600, video_quota.check_capacity),
]


def run_periodic(now: float) -> None:
    for task in PERIODIC:
        if now < task.next_at:
            continue
        task.schedule_next(now)
        try:
            with single_flight(task.name) as got:
                if got:
                    task.fn()
        except Exception:
            log.exception("periodic task %s failed", task.name)


# Main loop


def _log_crash(job_id: uuid.UUID) -> Callable[[Future], None]:
    """run_job handles job errors itself; anything escaping it would otherwise vanish inside the Future and leave
    the job 'running' until recover_stale."""
    def callback(future: Future) -> None:
        if exc := future.exception():
            log.error("job %s crashed outside its error handling", job_id, exc_info=exc)
    return callback


def run_loop(stop: threading.Event, worker_id: str | None = None) -> None:
    """Claim and run jobs until `stop` is set. Used by the CLI and, in development, by the API."""
    worker_id = worker_id or f"{socket.gethostname()}:{os.getpid()}"
    pool = ThreadPoolExecutor(max_workers=settings.worker_concurrency, thread_name_prefix="job")
    running: set[Future] = set()
    log.info("worker %s up, concurrency=%s", worker_id, settings.worker_concurrency)

    while not stop.is_set():
        running = {f for f in running if not f.done()}
        run_periodic(time.monotonic())
        claimed = False
        while len(running) < settings.worker_concurrency and not stop.is_set():
            try:
                with SessionLocal() as db:
                    job_id = claim_next(db, worker_id)
            except Exception:
                log.exception("claim failed")
                break
            if not job_id:
                break
            future = pool.submit(run_job, job_id)
            future.add_done_callback(_log_crash(job_id))
            running.add(future)
            claimed = True
        if not claimed:
            stop.wait(settings.worker_poll_seconds)

    log.info("worker %s stopping, waiting for %d running jobs", worker_id, len(running))
    pool.shutdown(wait=True)


def start_background(stop: threading.Event) -> threading.Thread:
    thread = threading.Thread(target=run_loop, args=(stop, f"api:{os.getpid()}"), name="worker", daemon=True)
    thread.start()
    return thread


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    run_loop(stop)


if __name__ == "__main__":
    main()
