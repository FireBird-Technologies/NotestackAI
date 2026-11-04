"""Render the app icons and splash image from their SVG sources (assets/icon-src) to 1024px PNGs (assets/images).

The stores and launchers only take PNGs, so the SVGs are the source and these PNGs are drawn from them at full size.
Uses Playwright's headless Chrome shell. Run from mobile/: python3 scripts/render-icons.py
"""

import glob
import subprocess
import tempfile
from pathlib import Path

from PIL import Image

SIZE = 1024
ROOT = Path(__file__).resolve().parent.parent
CHROME = glob.glob(str(Path.home() / "Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell"))[0]

for svg in sorted((ROOT / "assets/icon-src").glob("*.svg")):
    out = ROOT / "assets/images" / f"{svg.stem}.png"
    style = f"html,body{{margin:0;background:transparent}}svg{{display:block;width:{SIZE}px;height:{SIZE}px}}"
    page = f"<html><head><style>{style}</style></head><body>{svg.read_text()}</body></html>"
    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False) as f:
        f.write(page)
    subprocess.run(
        [CHROME, "--headless", "--hide-scrollbars", "--default-background-color=00000000", "--force-device-scale-factor=1",
         f"--window-size={SIZE},{SIZE}", f"--screenshot={out}", f"file://{f.name}"],
        check=True, capture_output=True, timeout=60,
    )
    if svg.stem == "icon":
        # The App Store refuses an app icon with an alpha channel.
        Image.open(out).convert("RGB").save(out)
    print(out.relative_to(ROOT))
