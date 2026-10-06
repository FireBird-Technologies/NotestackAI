"""Who owns what on our one blog2video account.

blog2video's ownership checks stop at the account: any video, custom template, custom voice or style made with our
key can be used, listed and edited with it. So every route that takes a blog2video id checks here first that it
belongs to the current workspace (404 otherwise, so another workspace's ids are never confirmed), and every create or
edit body has its references checked before it is forwarded (check_refs).
"""

import uuid

from fastapi import HTTPException
from sqlalchemy import select

from app.auth import Ctx
from app.models import Artifact, B2VCustomVoice, B2VStyle, B2VTemplate, B2VVideo
from app.services import blog2video as b2v
from app.services.notestack_voices import is_notestack_voice
from app.services.plans import Plan, effective_plan
from app.services.video_limits import require_premium

BUILTIN_STYLES = {"auto", "explainer", "storytelling", "promotional"}
# Custom styles made on our blog2video account itself, offered to every workspace in place of the others when they
# exist (matched by name, the first is the default). Each sets the video length; the wizard has no length picker and
# only says roughly how long the video comes out.
HOUSE_STYLES = [  # (name on blog2video, video length, what the wizard says it is: about three lines)
    ("Overview", "short", "A clear, neutral rundown of the key points. It gets straight to the main idea, one point per "
                          "scene in plain words. Best for quick social posts and teasers. Usually under a minute long."),
    ("Deep dive", "medium", "Sets up the context first, then works through the reasoning, examples and trade-offs, each "
                            "scene building on the last. Best for YouTube, tutorials and full explainers. Usually 1 to "
                            "2 minutes long."),
]
PREMIUM_LENGTHS = {"detailed", "more_detailed", "mdetailed"}


def not_found(what: str = "Not found") -> HTTPException:
    return HTTPException(404, what)


# Videos


def owned_video(ctx: Ctx, artifact_id: uuid.UUID) -> tuple[Artifact, int, B2VVideo | None]:
    """The artifact, blog2video's id, and our ledger row (None for videos made before the API key).

    The row is the reference: its b2v_video_id (and created_via) is what every blog2video call uses. The artifact's
    content_json only keeps a copy for the Library, and is read only for legacy videos, which have no row."""
    a = ctx.db.scalar(select(Artifact).where(Artifact.id == artifact_id, Artifact.workspace_id == ctx.workspace.id,
                                             Artifact.type == "video"))
    content = (a.content_json or {}) if a else {}
    if not a or content.get("provider") != "blog2video":
        raise not_found("Video not found")
    row = ctx.db.scalar(select(B2VVideo).where(B2VVideo.artifact_id == a.id,
                                               B2VVideo.workspace_id == ctx.workspace.id))
    if row is not None and row.b2v_video_id is not None:
        return a, row.b2v_video_id, row
    if row is None and content.get("b2v_video_id"):
        return a, int(content["b2v_video_id"]), None  # legacy
    raise not_found("Video not found")  # the create never got an id from blog2video


def video_or_404(ctx: Ctx, artifact_id: uuid.UUID) -> tuple[Artifact, int, B2VVideo]:
    """A video this workspace owns and blog2video can still reach with our key."""
    a, vid, row = owned_video(ctx, artifact_id)
    if row is None:
        raise HTTPException(410, {"code": "video_legacy",
                                  "message": "This video was made before the video service changed and can not be "
                                             "edited any more. Its links still work."})
    return a, vid, row


# Templates, voices, styles


def owned_template(ctx: Ctx, template_id: int) -> B2VTemplate:
    row = ctx.db.scalar(select(B2VTemplate).where(B2VTemplate.b2v_template_id == template_id,
                                                  B2VTemplate.workspace_id == ctx.workspace.id))
    if not row:
        raise not_found("Template not found")
    return row


def owned_custom_voice(ctx: Ctx, custom_voice_id: int) -> B2VCustomVoice:
    row = ctx.db.scalar(select(B2VCustomVoice).where(B2VCustomVoice.b2v_custom_voice_id == custom_voice_id,
                                                     B2VCustomVoice.workspace_id == ctx.workspace.id))
    if not row:
        raise not_found("Voice not found")
    return row


def owned_style(ctx: Ctx, style_id: int) -> B2VStyle:
    row = ctx.db.scalar(select(B2VStyle).where(B2VStyle.b2v_style_id == style_id,
                                               B2VStyle.workspace_id == ctx.workspace.id))
    if not row:
        raise not_found("Style not found")
    return row


def _custom_id(ref: str, prefix: str) -> int | None:
    raw = ref.removeprefix(prefix)
    return int(raw) if ref.startswith(prefix) and raw.isdigit() else None


def crafted_ids() -> set[str]:
    out = set()
    for t in b2v.crafted_templates():
        tid = t.get("id") if isinstance(t, dict) else t
        if isinstance(tid, str) and tid.startswith("crafted_"):
            out.add(tid)
    return out


def check_template(ctx: Ctx, template: str, plan: Plan) -> None:
    if template == "default":
        return
    if (cid := _custom_id(template, "custom_")) is not None:
        row = owned_template(ctx, cid)
        if not row.ready:
            raise HTTPException(400, "That template is still being made.")
        return
    if template.startswith("crafted_"):
        # blog2video silently falls back to "default" for an unknown id, so check it exists.
        if template not in crafted_ids():
            raise not_found("Template not found")
        require_premium(ctx.db, ctx.workspace, "Designer templates", plan)
        return
    if template not in {t.get("id") for t in b2v.builtin_templates() if isinstance(t, dict)}:
        raise not_found("Template not found")


def house_styles() -> list[dict]:
    """HOUSE_STYLES found among the account's custom styles, in HOUSE_STYLES order, with the length each sets."""
    by_name = {str(s.get("name") or "").strip().lower(): s for s in (b2v.video_styles() or {}).get("styles") or []
               if s.get("kind") == "custom" and s.get("custom_id") is not None}
    out = []
    for name, length, blurb in HOUSE_STYLES:
        if s := by_name.get(name.lower()):
            out.append({"id": f"custom:{s['custom_id']}", "custom_id": s["custom_id"], "name": s.get("name"),
                        "description": blurb, "kind": "house", "length": length})
    return out


def house_length(style: str | None) -> str | None:
    """The video length a house style sets; None for any other style."""
    if not style or not style.startswith("custom:"):
        return None
    return next((s["length"] for s in house_styles() if s["id"] == style), None)


def check_style(ctx: Ctx, style: str) -> None:
    if style in BUILTIN_STYLES:
        return
    if (sid := _custom_id(style, "custom:")) is not None:
        if any(s["custom_id"] == sid for s in house_styles()):
            return
        owned_style(ctx, sid)
        return
    raise not_found("Video style not found")  # includes your_style, which learns from every workspace's edits


def check_voice(ctx: Ctx, voice_id: str, plan: Plan) -> None:
    """A built-in voice (premium if blog2video marks it paid), or one of this workspace's custom or Notestack
    voices."""
    prebuilt = {v.get("voice_id"): v for v in b2v.prebuilt_voices()}
    if voice_id in prebuilt:
        if prebuilt[voice_id].get("plan") == "paid":
            require_premium(ctx.db, ctx.workspace, "This voice", plan)
        return
    if ctx.db.scalar(select(B2VCustomVoice).where(B2VCustomVoice.voice_id == voice_id,
                                                  B2VCustomVoice.workspace_id == ctx.workspace.id)):
        require_premium(ctx.db, ctx.workspace, "Custom voices", plan)
        return
    # One of this workspace's Notestack voices (clone, designed, added): same ElevenLabs account, premium like custom.
    if is_notestack_voice(ctx.db, ctx.workspace.id, voice_id):
        require_premium(ctx.db, ctx.workspace, "Custom voices", plan)
        return
    raise not_found("Voice not found")


def check_refs(ctx: Ctx, body: dict, plan: Plan | None = None) -> Plan:
    """Every id in a create or edit body must be this workspace's, and premium options need a paid plan."""
    plan = plan or effective_plan(ctx.db, ctx.workspace)
    if body.get("template"):
        check_template(ctx, str(body["template"]), plan)
    if body.get("video_style"):
        check_style(ctx, str(body["video_style"]))
    if body.get("custom_voice_id") and body.get("voice_gender") != "none":
        check_voice(ctx, str(body["custom_voice_id"]), plan)
    if str(body.get("video_length") or "") in PREMIUM_LENGTHS:
        require_premium(ctx.db, ctx.workspace, "Longer videos", plan)
    if body.get("voice_emotion"):
        require_premium(ctx.db, ctx.workspace, "Advanced voice options", plan)
    return plan


# Catalog, filtered to what this workspace may see


def visible_styles(ctx: Ctx) -> list[dict]:
    """The house styles when the account has them; otherwise built-in styles (read-only) and this workspace's custom
    styles. Never "Your Style", never others'."""
    if house := house_styles():
        return [{k: v for k, v in s.items() if k != "length"} for s in house]
    mine = set(ctx.db.scalars(select(B2VStyle.b2v_style_id).where(B2VStyle.workspace_id == ctx.workspace.id)))
    out = []
    for s in (b2v.video_styles() or {}).get("styles") or []:
        if s.get("kind") == "builtin" and s.get("id") in BUILTIN_STYLES:
            out.append({"id": s["id"], "name": s.get("name"), "description": s.get("description"), "kind": "builtin"})
        elif s.get("kind") == "custom" and s.get("custom_id") in mine:
            out.append({"id": s["id"], "custom_id": s["custom_id"], "name": s.get("name"),
                        "description": s.get("description"), "guidance": s.get("guidance"),
                        "version": s.get("version"), "kind": "custom"})
    return out


def my_templates(ctx: Ctx, ready_only: bool = False) -> list[B2VTemplate]:
    q = select(B2VTemplate).where(B2VTemplate.workspace_id == ctx.workspace.id)
    if ready_only:
        q = q.where(B2VTemplate.ready.is_(True))
    return list(ctx.db.scalars(q.order_by(B2VTemplate.created_at.desc())))
