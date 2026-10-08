"""Draws each infographic look with the sample content using a local Chrome, so the picker thumbnails can be regenerated.

  python scripts/render_theme_thumbnails.py     # writes ../frontend/public/infographics/<look>.png (small)
Set CHROME to the browser binary if it is not found."""

import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.infographics.design import LOOKS, SAMPLE, render_design  # noqa: E402
from app.infographics.image import chrome  # noqa: E402
from app.infographics.render import SIZES  # noqa: E402


def shoot(html: str, out: Path, layout: str) -> None:
    width, height = SIZES[layout]
    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False) as f:
        f.write(f'<!doctype html><meta charset="utf-8"><body style="margin:0">{html}</body>')
    subprocess.run([chrome(), "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", f"--window-size={width},{height}",
                    "--force-device-scale-factor=2", "--virtual-time-budget=8000", f"--screenshot={out}", f"file://{f.name}"], check=True, capture_output=True)


if __name__ == "__main__":
    folder = Path(__file__).resolve().parents[2] / "frontend/public/infographics"
    folder.mkdir(parents=True, exist_ok=True)
    for look in LOOKS:
        out = folder / f"{look}.png"
        shoot(render_design(look, SAMPLE, "landscape", fit=1.0), out, "landscape")
        subprocess.run(["sips", "--resampleWidth", "1400", str(out)], check=False, capture_output=True)  # drawn at 2x, kept at 1400 wide: sharp when shown large
        print(out)
