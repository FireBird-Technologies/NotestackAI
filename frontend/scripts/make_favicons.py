"""Favicons from the logo mark (public/logo.svg), rendered with the renderer's headless Chrome.

Writes to public/: favicon.ico (16, 32, 48), favicon-32.png, apple-touch-icon.png (180, full bleed:
iOS rounds the corners itself), icon-192.png, icon-512.png and icon-maskable-512.png (planet inside
Android's 80% safe zone). Run from the repo root:  python frontend/scripts/make_favicons.py
"""

import struct
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "frontend" / "public"
CHROME = next((ROOT / "renderer" / "node_modules" / ".remotion").rglob("chrome-headless-shell.exe"))
MARK = (PUBLIC / "logo.svg").read_text(encoding="utf-8")

# The planet and sparkle without the rounded tile, to place on a full bleed square.
ART = """
  <circle cx="26" cy="36" r="13" fill="#000000"/>
  <ellipse cx="26" cy="36" rx="21" ry="5" fill="none" stroke="#000000" stroke-width="3" transform="rotate(-18 26 36)"/>
  <path d="M46 10 l2.2 5.8 5.8 2.2 -5.8 2.2 -2.2 5.8 -2.2 -5.8 -5.8 -2.2 5.8 -2.2z" fill="#000000"/>
"""


def full_bleed(scale: float) -> str:
    """White square, artwork scaled about the centre (iOS and Android apply their own masks)."""
    off = 32 * (1 - scale)
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
        '<rect width="64" height="64" fill="#ffffff"/>'
        f'<g transform="translate({off} {off}) scale({scale})">{ART}</g></svg>'
    )


def render(svg: str, size: int, out: Path) -> bytes:
    with tempfile.TemporaryDirectory() as tmp:
        page = Path(tmp) / "icon.html"
        page.write_text(
            "<!doctype html><html><body style='margin:0;background:transparent'>"
            f"<div style='width:{size}px;height:{size}px'>{svg.replace('<svg ', f'<svg width=\"{size}\" height=\"{size}\" ', 1)}</div>"
            "</body></html>",
            encoding="utf-8",
        )
        shot = Path(tmp) / "shot.png"
        subprocess.run(
            [str(CHROME), "--headless", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
             "--default-background-color=00000000", f"--window-size={size},{size}",
             f"--screenshot={shot}", page.as_uri()],
            check=True, capture_output=True,
        )
        data = shot.read_bytes()
    out.write_bytes(data)
    return data


def ico(images: dict[int, bytes]) -> bytes:
    """ICO with PNG payloads (supported by every browser since IE Vista era)."""
    header = struct.pack("<HHH", 0, 1, len(images))
    entries, blobs, offset = b"", b"", 6 + 16 * len(images)
    for size, png in sorted(images.items()):
        entries += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(png), offset)
        blobs += png
        offset += len(png)
    return header + entries + blobs


tmp_dir = Path(tempfile.mkdtemp())
small = {s: render(MARK, s, tmp_dir / f"f{s}.png") for s in (16, 32, 48)}
(PUBLIC / "favicon.ico").write_bytes(ico(small))
(PUBLIC / "favicon-32.png").write_bytes(small[32])
render(full_bleed(0.86), 180, PUBLIC / "apple-touch-icon.png")
render(MARK, 192, PUBLIC / "icon-192.png")
render(MARK, 512, PUBLIC / "icon-512.png")
render(full_bleed(0.7), 512, PUBLIC / "icon-maskable-512.png")
for name in ("favicon.ico", "favicon-32.png", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png"):
    print(name, (PUBLIC / name).stat().st_size)
