"""Draws a sample opening slide in each slide deck theme with a local Chrome, for the theme picker's thumbnails.

  python scripts/render_slide_thumbnails.py      # writes ../frontend/public/slides/<theme>.png
Set CHROME to the browser binary if it is not found (see app.infographics.image.chrome)."""

import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from PIL import Image  # noqa: E402

from app.infographics.image import chrome  # noqa: E402
from app.slides.content import clamp_deck  # noqa: E402
from app.slides.render import slide_html  # noqa: E402
from app.slides.themes import THEMES  # noqa: E402

SAMPLE = {"title": "Your ideas, in orbit", "slides": [
    {"layout": "title", "kicker": "Slide deck", "heading": "Your ideas, in orbit",
     "lead": "Every post you have written, turned into a story worth presenting."},
]}

PICK = {"dark-space": "b", "light-space": "a"}  # each theme's most telling opener

if __name__ == "__main__":
    binary = chrome()
    if not binary:
        sys.exit("No Chrome found: set CHROME")
    folder = Path(__file__).resolve().parents[2] / "frontend/public/slides"
    folder.mkdir(parents=True, exist_ok=True)
    deck = clamp_deck(SAMPLE, "presenter")
    for tid in THEMES:
        deck["slides"][0]["variant"] = PICK[tid]
        with tempfile.TemporaryDirectory() as tmp:
            src, shot = Path(tmp) / "s.html", Path(tmp) / "s.png"
            src.write_text(slide_html(deck, 0, tid, "presenter", 2024), encoding="utf-8")
            subprocess.run([binary, "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
                            "--force-device-scale-factor=1", f"--user-data-dir={tmp}/p", "--window-size=1920,1080",
                            "--virtual-time-budget=8000", f"--screenshot={shot}", f"file://{src}"],
                           check=True, capture_output=True, timeout=120)
            Image.open(shot).convert("RGB").resize((800, 450), Image.LANCZOS).save(folder / f"{tid}.png", optimize=True)
        print(folder / f"{tid}.png")
