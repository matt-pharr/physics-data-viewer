#!/usr/bin/env python3
"""Generate 1024x1024 layer PNGs from the PDV icon SVG for Icon Composer.

Produces three layers:
  - background.png: solid #14121c fill (no rounded corners — system applies squircle mask)
  - glow.png: two concentric glow circles on transparent background
  - particles.png: four solid circles on transparent background

All coordinates are scaled from the 56x56 viewBox to 1024x1024.
"""

from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:
    raise SystemExit("Pillow is required: pip install Pillow")

OUTPUT_DIR = Path(__file__).resolve().parent.parent / "electron" / "assets" / "icon-layers"
SIZE = 1024
SCALE = SIZE / 56  # 56 → 1024


def scaled(v: float) -> float:
    return v * SCALE


def draw_circle(draw: ImageDraw.ImageDraw, cx: float, cy: float, r: float, fill, **kwargs):
    x0, y0 = scaled(cx - r), scaled(cy - r)
    x1, y1 = scaled(cx + r), scaled(cy + r)
    draw.ellipse([x0, y0, x1, y1], fill=fill, **kwargs)


def hex_to_rgba(hex_color: str, opacity: float = 1.0) -> tuple:
    h = hex_color.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return (r, g, b, int(opacity * 255))


def make_background():
    img = Image.new("RGBA", (SIZE, SIZE), hex_to_rgba("#14121c"))
    img.save(OUTPUT_DIR / "background.png")
    print(f"  background.png ({SIZE}x{SIZE})")


def make_glow():
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    # Outer glow: r=26, opacity 0.1
    draw_circle(draw, 28, 28, 26, fill=hex_to_rgba("#7F77DD", 0.1))
    # Inner glow: r=22, opacity 0.14
    draw_circle(draw, 28, 28, 22, fill=hex_to_rgba("#7F77DD", 0.14))
    img.save(OUTPUT_DIR / "glow.png")
    print(f"  glow.png ({SIZE}x{SIZE})")


def make_particles():
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw_circle(draw, 23, 23, 10, fill=hex_to_rgba("#7F77DD"))  # top-left dark
    draw_circle(draw, 33, 23, 10, fill=hex_to_rgba("#AFA9EC"))  # top-right light
    draw_circle(draw, 23, 33, 10, fill=hex_to_rgba("#AFA9EC"))  # bottom-left light
    draw_circle(draw, 33, 33, 10, fill=hex_to_rgba("#7F77DD"))  # bottom-right dark
    img.save(OUTPUT_DIR / "particles.png")
    print(f"  particles.png ({SIZE}x{SIZE})")


if __name__ == "__main__":
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Generating icon layers in {OUTPUT_DIR}/")
    make_background()
    make_glow()
    make_particles()
    print("Done.")
