"""An infographic's PNG: its stored HTML page drawn by a headless Chrome at the page's own size. No Remotion, no
browser library: one `chrome --headless --screenshot` run per download (the result is kept for the next one)."""

import glob
import hashlib
import os
import shutil
import subprocess
import tempfile
from collections import OrderedDict
from pathlib import Path
from threading import Lock

from app.infographics.render import SIZES

TIMEOUT = 60  # seconds for one drawing
KEEP = 8  # drawings kept in memory

_cache: OrderedDict[str, bytes] = OrderedDict()
_lock = Lock()


class ImageUnavailable(Exception):
    """No Chrome to draw with, or it failed."""


def chrome() -> str | None:
    """CHROME, or a Chrome / Chromium found on the machine."""
    if env := os.environ.get("CHROME"):
        return env if Path(env).exists() else None
    for name in ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome"):
        if found := shutil.which(name):
            return found
    patterns = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                os.path.expanduser("~/.cache/puppeteer/chrome/*/chrome-mac-*/"
                                   "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")]
    return next((p for pat in patterns for p in glob.glob(pat)), None)


def render_png(html: str, layout: str = "portrait") -> bytes:
    """The page as a PNG at its own size: tall (1600 x 2260) or wide (2260 x 1600)."""
    width, height = SIZES.get(layout, SIZES["portrait"])
    key = hashlib.sha256(f"{width}x{height}{html}".encode()).hexdigest()
    with _lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]
    binary = chrome()
    if not binary:
        raise ImageUnavailable("No Chrome is installed here to draw the image.")
    page = f'<!doctype html><meta charset="utf-8"><body style="margin:0">{html}</body>'
    with tempfile.TemporaryDirectory() as tmp:
        src, out = Path(tmp) / "page.html", Path(tmp) / "out.png"
        src.write_text(page, encoding="utf-8")
        cmd = [binary, "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", "--force-device-scale-factor=1",
               f"--user-data-dir={tmp}/profile", f"--window-size={width},{height}", "--virtual-time-budget=8000",
               f"--screenshot={out}", f"file://{src}"]
        try:
            subprocess.run(cmd, check=True, capture_output=True, timeout=TIMEOUT)
        except (subprocess.SubprocessError, OSError) as exc:
            raise ImageUnavailable("The image could not be drawn.") from exc
        if not out.exists():
            raise ImageUnavailable("The image could not be drawn.")
        data = out.read_bytes()
    with _lock:
        _cache[key] = data
        while len(_cache) > KEEP:
            _cache.popitem(last=False)
    return data
