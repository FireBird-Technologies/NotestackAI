"""What a scheduled post carries from the artifact it was made from: images (quote cards, carousel slides, a slide
deck's slides, drawn when the post goes out) or one
video (an audiogram, or a blog2video video), or a file the user uploaded from their computer (an `upload`: one image or
one MP4). Summaries, launch kits and mind maps post as text; audio overviews can't
be posted (X and LinkedIn take no audio files).

Videos are streamed to a temporary file (never held whole in memory) and read in slices by the uploaders; the files are
removed when the post is done (media_for is a context manager). Sizes are checked before anything is sent."""

import contextlib
import os
import tempfile
from collections.abc import Iterator
from dataclasses import dataclass

import httpx
from fastapi import HTTPException

from app.models import Artifact
from app.services.social import SocialError

MAX_IMAGES = {"x": 4, "linkedin": 20}
X_VIDEO_SECONDS = 140  # X's limit for videos from standard accounts (2:20)
TEXT_ONLY = {"summary", "launch_kit", "mind_map"}
MEDIA_PLATFORMS = {"x", "linkedin"}
MB = 1024 * 1024
# What the user can upload from their computer to post: LinkedIn takes JPG, PNG and GIF images and MP4 videos.
UPLOAD_TYPES = {"image/png": "image", "image/jpeg": "image", "image/gif": "image", "video/mp4": "video"}
# (min, max) bytes per platform and kind, checked before any upload starts
SIZE_LIMITS = {
    ("x", "image"): (1, 5 * MB),
    ("x", "video"): (1, 512 * MB),
    ("linkedin", "image"): (1, 36 * MB),
    ("linkedin", "video"): (75 * 1024, 500 * MB),
}


@dataclass
class Media:
    kind: str  # image | video
    filename: str
    content_type: str
    data: bytes | None = None  # images: the bytes
    path: str | None = None  # videos: a temporary file
    size: int = 0

    def __post_init__(self):
        if self.data is not None:
            self.size = len(self.data)
        elif self.path:
            self.size = os.path.getsize(self.path)

    def read(self, start: int = 0, end: int | None = None) -> bytes:
        """Bytes [start, end) (all of them by default)."""
        end = self.size if end is None else min(end, self.size)
        if self.data is not None:
            return self.data[start:end]
        with open(self.path, "rb") as f:
            f.seek(start)
            return f.read(end - start)


def is_blog2video(a: Artifact) -> bool:
    return (a.content_json or {}).get("provider") == "blog2video"


def media_count(a: Artifact) -> int:
    """How many files a post of this artifact carries (before a platform's cap)."""
    if a.type == "quote_card":
        return 1
    if a.type == "carousel":
        return len((a.content_json or {}).get("slide_keys") or ([a.storage_key] if a.storage_key else []))
    if a.type == "slide_deck":
        return len(((a.content_json or {}).get("deck") or {}).get("slides") or [])
    if a.type in ("video", "upload"):
        return 1
    return 0


def carries_media(a: Artifact | None) -> bool:
    """Whether a post of this artifact carries images or a video: such a post may go out without a caption."""
    return a is not None and a.type not in TEXT_ONLY and media_count(a) > 0


def upload_kind(a: Artifact) -> str | None:
    """An uploaded file's kind: image | video."""
    return (a.content_json or {}).get("media") if a.type == "upload" else None


def duration(a: Artifact) -> float | None:
    """A video's length when we know it (audiograms record it; blog2video's is only known to blog2video)."""
    value = (a.content_json or {}).get("duration_s")
    return float(value) if value else None


def check_postable(a: Artifact, platform: str) -> None:
    """400 when this artifact can't go out on this platform, so it is refused when scheduled, not at post time."""
    if a.type == "audio_overview":
        raise HTTPException(400, "Audio can't be posted: X and LinkedIn don't take audio files.")
    if a.type == "launch_kit":  # a post is written from a kit (kit_id); the kit itself is never an attachment
        raise HTTPException(400, "A launch kit can't be attached. Attach a video, quote card or carousel instead.")
    if a.type not in TEXT_ONLY and a.type not in ("quote_card", "carousel", "video", "upload", "slide_deck"):
        raise HTTPException(400, "This can't be posted.")
    if a.type in TEXT_ONLY:
        return
    if platform not in MEDIA_PLATFORMS:
        raise HTTPException(400, "Images and videos can only be posted to X and LinkedIn.")
    if a.type == "slide_deck":  # drawn from the deck when the post goes out: nothing stored to wait for
        if a.status != "ready" or not media_count(a):
            raise HTTPException(400, "This slide deck isn't ready yet. Post it once it has finished.")
    elif a.type == "video" and is_blog2video(a):
        if not (a.content_json or {}).get("video_url"):
            raise HTTPException(400, "This video isn't finished yet. Post it once it has rendered.")
    elif a.status != "ready" or not a.storage_key:
        raise HTTPException(400, "This isn't ready yet. Post it once it has finished.")
    seconds = duration(a) if a.type == "video" else None
    if platform == "x" and seconds and seconds > X_VIDEO_SECONDS:
        raise HTTPException(400, f"This video is {int(seconds // 60)}:{int(seconds % 60):02d} long; X takes videos "
                                 "up to 2:20. Post it to LinkedIn, or make a shorter one.")


def check_size(m: Media, platform: str) -> None:
    """Too big (or, on LinkedIn, too small a video): a clear permanent error before any network call."""
    low, high = SIZE_LIMITS.get((platform, m.kind), (1, 1 << 40))
    label = "X" if platform == "x" else "LinkedIn"
    if m.size > high:
        raise SocialError(f"This {m.kind} is {m.size / MB:.0f} MB; {label} takes up to {high // MB} MB.", permanent=True)
    if m.size < low:
        raise SocialError(f"This {m.kind} is too small for {label} (at least {low // 1024} KB).", permanent=True)


@contextlib.contextmanager
def media_for(a: Artifact | None, platform: str) -> Iterator[list[Media]]:
    """The files to upload with a post of this artifact (none for text-only ones), size checked. Temporary video
    files are deleted when the block ends, also on errors."""
    from app.services.storage import storage

    temps: list[str] = []
    try:
        out: list[Media] = []
        if a is not None and a.type not in TEXT_ONLY and platform in MEDIA_PLATFORMS:
            if a.type == "quote_card":
                out = [Media("image", "quote.png", "image/png", data=storage.get_bytes(a.storage_key))]
            elif a.type == "carousel":
                keys = (a.content_json or {}).get("slide_keys") or [a.storage_key]
                out = [Media("image", f"slide-{i + 1}.png", "image/png", data=storage.get_bytes(k))
                       for i, k in enumerate(keys[:MAX_IMAGES[platform]])]
            elif a.type == "slide_deck":
                out = [Media("image", f"slide-{i + 1}.png", "image/png", data=png)
                       for i, png in enumerate(_slide_images(a, MAX_IMAGES[platform]))]
            elif a.type == "upload" and upload_kind(a) == "image":
                c = a.content_json or {}
                out = [Media("image", c.get("filename") or "image", c.get("content_type") or "image/png",
                             data=storage.get_bytes(a.storage_key))]
            elif a.type == "upload":
                path = _temp_file(temps)
                with open(path, "wb") as f:
                    storage.download_to(a.storage_key, f)
                out = [Media("video", (a.content_json or {}).get("filename") or "video.mp4", "video/mp4", path=path)]
            elif a.type == "video":
                path = _temp_file(temps)
                with open(path, "wb") as f:
                    if is_blog2video(a):
                        _download(a.content_json["video_url"], f)
                    else:
                        storage.download_to(a.storage_key, f)
                out = [Media("video", "video.mp4", "video/mp4", path=path)]
        for m in out:
            check_size(m, platform)
        yield out
    finally:
        for path in temps:
            with contextlib.suppress(OSError):
                os.unlink(path)


def _slide_images(a: Artifact, limit: int) -> list[bytes]:
    """A slide deck's first `limit` slides as PNGs, exactly as the deck shows them."""
    from app.infographics.image import ImageUnavailable
    from app.slides import export
    from app.slides.build import stored

    got = stored(a.content_json or {})
    if not got:
        raise SocialError("This slide deck has no slides to post.", permanent=True)
    try:
        return export.render_slide_pngs(*got, limit=limit)
    except ImageUnavailable as exc:  # no Chrome on this worker right now: worth another try
        raise SocialError(f"The slides could not be drawn: {exc}") from exc


def _temp_file(temps: list[str]) -> str:
    fd, path = tempfile.mkstemp(prefix="notestack-post-", suffix=".mp4")
    os.close(fd)
    temps.append(path)
    return path


def _download(url: str, f) -> None:
    with httpx.stream("GET", url, timeout=120, follow_redirects=True) as resp:
        resp.raise_for_status()
        for chunk in resp.iter_bytes(1024 * 1024):
            f.write(chunk)
