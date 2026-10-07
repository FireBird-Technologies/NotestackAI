"""Draws every infographic theme with the sample content (and, with --stress, the longest text allowed) using a local
Chrome, so the themes can be checked by eye and the picker thumbnails regenerated.

  python scripts/render_theme_thumbnails.py            # writes ../frontend/public/infographics/<theme>.png (small)
  python scripts/render_theme_thumbnails.py --stress   # writes full-size stress renders to a temp folder
Set CHROME to the browser binary if it is not found."""

import glob
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.infographics.content import HEIGHT, SAMPLE, STRESS, WIDTH, clamp  # noqa: E402
from app.infographics.render import thumbnail_html  # noqa: E402
from app.infographics.themes import THEMES  # noqa: E402

def chrome() -> str:
    found = os.environ.get("CHROME") or next(iter(glob.glob(os.path.expanduser("~/.cache/puppeteer/chrome/*/chrome-mac-*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"))), "") \
        or "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    return found


def shoot(html: str, out: Path) -> None:
    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False) as f:
        f.write(html)
    subprocess.run([chrome(), "--headless=new", "--disable-gpu", "--hide-scrollbars", f"--window-size={WIDTH},{HEIGHT}",
                    "--virtual-time-budget=8000", f"--screenshot={out}", f"file://{f.name}"], check=True, capture_output=True)
    os.unlink(f.name)


if __name__ == "__main__":
    stress = "--stress" in sys.argv
    folder = Path(tempfile.gettempdir()) / "ig-stress" if stress else Path(__file__).resolve().parents[2] / "frontend/public/infographics"
    folder.mkdir(parents=True, exist_ok=True)
    content = clamp(STRESS if stress else SAMPLE)
    for tid in THEMES:
        out = folder / f"{tid}.png"
        shoot(thumbnail_html(tid, content), out)
        if not stress:  # picker thumbnails: a third of the size is plenty
            subprocess.run(["sips", "--resampleWidth", "560", str(out)], check=False, capture_output=True)
        print(out)
