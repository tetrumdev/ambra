"""Regenerates the mobile app's PNG icons from desktop's Icon Composer waveform.

iOS 26+ uses the Icon Composer file itself (app.json `ios.icon`); these PNGs are the fallback
icon and Android's adaptive icon layers. Run after changing
desktop/src-tauri/icons/macIcon.icon:  python mobile/scripts/make-icons.py
"""
from pathlib import Path

from PIL import Image

root = Path(__file__).resolve().parents[2]
waveform = Image.open(root / "desktop/src-tauri/icons/macIcon.icon/Assets/ambraWaveform.png").convert("RGBA")
assets = root / "mobile/assets"
# As the Mac icon renders: light bars on near-black (desktop/src-tauri/icons/macIcon.png).
BAR = (228, 228, 228)
TOP, BOTTOM = (34, 34, 34), (20, 20, 20)
SIZE = 1024


def bars(width: int, color=BAR) -> Image.Image:
    """The waveform `width` wide, recolored to `color`, keeping its shape's alpha."""
    height = round(waveform.height * width / waveform.width)
    alpha = waveform.getchannel("A").resize((width, height), Image.LANCZOS)
    solid = Image.new("RGBA", (width, height), color + (255,))
    solid.putalpha(alpha)
    return solid


def centered(canvas: Image.Image, layer: Image.Image) -> Image.Image:
    canvas.alpha_composite(layer, ((canvas.width - layer.width) // 2, (canvas.height - layer.height) // 2))
    return canvas


def background() -> Image.Image:
    gradient = Image.new("RGBA", (SIZE, SIZE))
    for y in range(SIZE):
        t = y / (SIZE - 1)
        color = tuple(round(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3)) + (255,)
        gradient.paste(color, (0, y, SIZE, y + 1))
    return gradient


# Full-bleed square: iOS rounds the corners itself, so no transparency.
icon = centered(background(), bars(round(SIZE * 0.66))).convert("RGB")
icon.save(assets / "icon.png")
icon.resize((48, 48), Image.LANCZOS).save(assets / "favicon.png")
# Android adaptive icon: the mask may crop to a circle, so the bars stay in the central safe zone.
background().convert("RGB").save(assets / "android-icon-background.png")
centered(Image.new("RGBA", (SIZE, SIZE)), bars(round(SIZE * 0.42))).save(assets / "android-icon-foreground.png")
centered(Image.new("RGBA", (SIZE, SIZE)), bars(round(SIZE * 0.42), (255, 255, 255))).save(assets / "android-icon-monochrome.png")
print("icons written to", assets)
