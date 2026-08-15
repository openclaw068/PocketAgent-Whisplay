"""
PocketAgent robot face renderer.

An original character design: rounded dome head, angular glowing eyes, minimal
features, dark background. Drawn procedurally — no image assets to ship.

Design notes
------------
* The face layer is drawn at SUPERSAMPLE x resolution and downscaled with
  LANCZOS. PIL has no antialiasing on ellipse/arc/polygon, and at 240x280 the
  jaggies on a curved head are very obvious. Downscaling is done in C and is
  cheap relative to how much better it looks.
* Backgrounds are cached per accent colour. They are static, so rebuilding one
  every frame would be pure waste on a Pi Zero 2 W.
* Everything is expression-driven: `EXPRESSIONS` maps a status to eye/mouth
  shape parameters, so tuning the face means editing that table, not the
  drawing code.
"""

from __future__ import annotations

import math
import os

try:
    from PIL import Image, ImageDraw, ImageFilter
except Exception:  # pragma: no cover
    Image = ImageDraw = ImageFilter = None


# --- Tunables -----------------------------------------------------------
# Supersampling factor for the face layer. 2 is a good quality/cost balance;
# set to 1 on very constrained hardware to skip the downscale entirely.
SUPERSAMPLE = int(os.environ.get("POCKETAGENT_FACE_SUPERSAMPLE", "2"))

# Enable the soft glow pass behind the eyes. Costs one gaussian blur per frame.
GLOW = (os.environ.get("POCKETAGENT_FACE_GLOW", "true").lower() == "true")

# The shell deliberately does NOT start at pure white: a white specular
# highlight is invisible against a white surface, and the panel is RGB565 so
# there is little headroom at the top of the range anyway.
SHELL_LIGHT = (226, 231, 238)
SHELL_MID = (196, 203, 213)
SHELL_DARK = (132, 141, 156)
SHELL_RIM = (78, 86, 100)


# Accent colour per status. Drives eyes, antenna tip and background glow.
ACCENTS = {
    "idle":         (120, 230, 130),
    "listening":    (90, 210, 255),
    "transcribing": (255, 200, 90),
    "thinking":     (255, 190, 80),
    "speaking":     (130, 240, 140),
    "reminder":     (255, 165, 70),
    "error":        (255, 105, 105),
}


# Expression table.
#   eye:   'happy'  upward crescent  (content / default)
#          'wide'   full rounded eye (alert, listening)
#          'narrow' squinted bar     (thinking, working)
#          'flat'   angled down      (error)
#   mouth: 'smile' | 'grin' | 'small' | 'flat' | 'talk'
EXPRESSIONS = {
    "idle":         {"eye": "happy",  "mouth": "smile"},
    "listening":    {"eye": "wide",   "mouth": "small"},
    "transcribing": {"eye": "narrow", "mouth": "small"},
    "thinking":     {"eye": "narrow", "mouth": "small"},
    "speaking":     {"eye": "happy",  "mouth": "talk"},
    "reminder":     {"eye": "wide",   "mouth": "grin"},
    "error":        {"eye": "flat",   "mouth": "flat"},
}


def accent_for(status: str):
    return ACCENTS.get((status or "idle").lower(), ACCENTS["idle"])


def expression_for(status: str):
    return EXPRESSIONS.get((status or "idle").lower(), EXPRESSIONS["idle"])


# --- Background ---------------------------------------------------------

_BG_CACHE: dict = {}


def build_background(w: int, h: int, accent, seed: int = 7):
    """Dark vertical gradient + faint starfield + a soft accent glow.

    Replaces the previous photo background (hyperion.jpg), which fought with
    the face for contrast and had to be darkened by 70/255 to stay readable.
    A generated background costs no disk, scales to any panel size, and lets
    the accent colour carry the device's state.
    """
    if Image is None:
        raise RuntimeError("PIL not installed (install python3-pil)")

    key = (w, h, tuple(accent), seed)
    cached = _BG_CACHE.get(key)
    if cached is not None:
        return cached

    img = Image.new("RGB", (w, h), (8, 10, 16))
    d = ImageDraw.Draw(img)

    # Vertical gradient: slightly lifted at the top, near-black at the bottom.
    top = (16, 20, 32)
    bottom = (5, 6, 11)
    for y in range(h):
        f = y / max(1, h - 1)
        d.line(
            [(0, y), (w, y)],
            fill=(
                int(top[0] + (bottom[0] - top[0]) * f),
                int(top[1] + (bottom[1] - top[1]) * f),
                int(top[2] + (bottom[2] - top[2]) * f),
            ),
        )

    # Deterministic starfield — same stars every boot, no RNG import needed.
    rnd = seed
    for _ in range(46):
        rnd = (rnd * 1103515245 + 12345) & 0x7FFFFFFF
        x = rnd % w
        rnd = (rnd * 1103515245 + 12345) & 0x7FFFFFFF
        y = rnd % int(h * 0.78)
        rnd = (rnd * 1103515245 + 12345) & 0x7FFFFFFF
        v = 70 + (rnd % 130)
        d.point((x, y), fill=(v, v, min(255, v + 18)))

    # Soft accent glow behind where the head sits, so state reads even at a
    # glance from across the room.
    glow = Image.new("RGB", (w, h), (0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gx, gy, gr = w // 2, int(h * 0.46), int(w * 0.46)
    gd.ellipse((gx - gr, gy - gr, gx + gr, gy + gr),
               fill=(accent[0] // 7, accent[1] // 7, accent[2] // 7))
    if ImageFilter is not None:
        glow = glow.filter(ImageFilter.GaussianBlur(radius=26))

    img = Image.blend(img, Image.blend(img, glow, 0.0), 0.0)
    img = _screen(img, glow)

    _BG_CACHE[key] = img
    return img


def _screen(base, layer):
    """Screen blend — brightens without washing out the darks."""
    import operator
    from PIL import ImageChops
    return ImageChops.screen(base, layer)


# --- Face ---------------------------------------------------------------


def _soft_shape(size, color, alpha, draw_fn, blur_radius):
    """Build a blurred solid-colour shape without dark edge fringing.

    Blurring an RGBA layer directly also blurs the RGB channels, and fully
    transparent pixels carry RGB (0,0,0) — so the blur pulls black into every
    edge and a white highlight comes out as a grey smudge. Blurring ONLY the
    alpha channel and keeping RGB flat avoids that entirely.
    """
    mask = Image.new("L", size, 0)
    draw_fn(ImageDraw.Draw(mask))
    if blur_radius > 0 and ImageFilter is not None:
        mask = mask.filter(ImageFilter.GaussianBlur(radius=blur_radius))
    if alpha < 255:
        mask = mask.point(lambda v: (v * alpha) // 255)
    layer = Image.new("RGBA", size, tuple(color) + (0,))
    layer.putalpha(mask)
    return layer


def _eye_shape(d, cx, cy, rx, ry, kind, accent, s, side=1):
    """Draw one eye.

    `s` is the supersample factor (coords are already scaled).
    `side` is -1 for the left eye, +1 for the right — needed for asymmetric
    expressions. Deriving it from cx does not work: cx is an absolute canvas
    coordinate and is always positive, so both eyes would tilt the same way.
    """
    a = accent
    if kind == "wide":
        d.ellipse((cx - rx, cy - ry, cx + rx, cy + ry), fill=a)

    elif kind == "happy":
        # Upward crescent: an arc thick enough to read as a closed, smiling eye.
        # This is the shape that makes the face unambiguously happy rather than
        # neutral — a straight bar or a plain circle both read as blank.
        box = (cx - rx, cy - ry, cx + rx, cy + ry * 2)
        d.arc(box, start=190, end=350, fill=a, width=max(2, int(7 * s)))

    elif kind == "narrow":
        d.rounded_rectangle((cx - rx, cy - int(ry * 0.34), cx + rx, cy + int(ry * 0.34)),
                            radius=int(ry * 0.34), fill=a)

    elif kind == "flat":
        # Angled down toward the centre — reads as concerned / alarmed.
        # Inner edge low, outer edge high.
        tilt = int(ry * 0.42)
        th = int(ry * 0.42)
        inner_y = cy + tilt
        outer_y = cy - tilt
        x_in, x_out = (cx + rx * side, cx - rx * side)
        d.polygon(
            [(x_out, outer_y), (x_in, inner_y),
             (x_in, inner_y + th), (x_out, outer_y + th)],
            fill=a,
        )

    else:  # blink
        d.rounded_rectangle((cx - rx, cy - int(3 * s), cx + rx, cy + int(3 * s)),
                            radius=int(3 * s), fill=a)


def _mouth(d, cx, cy, kind, accent, phase, s):
    """`phase` is a discrete 0-3 mouth-opening step (see draw_face)."""
    w = int(30 * s)
    if kind == "talk":
        if phase < 1:
            d.arc((cx - w, cy - int(6 * s), cx + w, cy + int(20 * s)),
                  start=15, end=165, fill=accent, width=max(2, int(5 * s)))
        elif phase < 2:
            d.ellipse((cx - int(11 * s), cy - int(2 * s), cx + int(11 * s), cy + int(16 * s)),
                      outline=accent, width=max(2, int(5 * s)))
        elif phase < 3:
            d.ellipse((cx - int(15 * s), cy - int(5 * s), cx + int(15 * s), cy + int(20 * s)),
                      outline=accent, width=max(2, int(5 * s)))
        else:
            d.arc((cx - w, cy - int(4 * s), cx + w, cy + int(22 * s)),
                  start=15, end=165, fill=accent, width=max(2, int(5 * s)))

    elif kind == "grin":
        d.arc((cx - w, cy - int(10 * s), cx + w, cy + int(22 * s)),
              start=10, end=170, fill=accent, width=max(2, int(6 * s)))

    elif kind == "small":
        d.arc((cx - int(16 * s), cy - int(2 * s), cx + int(16 * s), cy + int(12 * s)),
              start=20, end=160, fill=accent, width=max(2, int(4 * s)))

    elif kind == "flat":
        d.rounded_rectangle((cx - int(18 * s), cy + int(2 * s), cx + int(18 * s), cy + int(6 * s)),
                            radius=int(2 * s), fill=accent)

    else:  # smile
        d.arc((cx - w, cy - int(8 * s), cx + w, cy + int(18 * s)),
              start=15, end=165, fill=accent, width=max(2, int(5 * s)))


# --- Sprite cache -------------------------------------------------------
# The face only has a small number of *distinct* appearances: one per
# (status, eye shape, mouth phase). Everything else that moves — the breathing
# bob and the antenna pulse — is a translation or a single small dot.
#
# So each distinct appearance is drawn supersampled ONCE, downscaled, and
# cached at final resolution. Per-frame cost then collapses to one paste plus
# one small ellipse, instead of ~20 draw ops, three gaussian blurs and a
# 4x-resolution downscale every single frame.

_SPRITE_CACHE: dict = {}
_SPRITE_CACHE_MAX = 48


def _build_face_sprite(size, status, eye_kind, mouth_phase, eye_drift, face_alpha):
    W, H = size
    s = max(1, SUPERSAMPLE)
    layer = Image.new("RGBA", (W * s, H * s), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    accent = accent_for(status)
    expr = expression_for(status)

    cx = (W // 2) * s
    cy = int(H * 0.44 * s)
    rx = int(W * 0.30 * s)
    ry = int(W * 0.335 * s)

    # --- Antenna stem (behind the head so it tucks in cleanly) ---
    ax, ay = cx, cy - ry
    d.line((ax, ay - int(2 * s), ax, ay - int(22 * s)),
           fill=SHELL_DARK + (face_alpha,), width=max(1, int(3 * s)))

    # --- Head shell ---
    d.ellipse((cx - rx, cy - ry, cx + rx, cy + ry), fill=SHELL_LIGHT + (face_alpha,))

    # Vertical gradient across the shell, clipped to the head silhouette.
    grad = Image.new("RGBA", (1, 2 * ry), (0, 0, 0, 0))
    gp = grad.load()
    for i in range(2 * ry):
        f = i / max(1, 2 * ry - 1)
        f = f * f  # ease: keep the crown bright, bunch falloff toward the jaw
        col = tuple(int(SHELL_LIGHT[c] + (SHELL_DARK[c] - SHELL_LIGHT[c]) * f) for c in range(3))
        gp[0, i] = col + (face_alpha,)
    grad = grad.resize((2 * rx, 2 * ry))

    head_mask = Image.new("L", (2 * rx, 2 * ry), 0)
    ImageDraw.Draw(head_mask).ellipse((0, 0, 2 * rx - 1, 2 * ry - 1), fill=255)
    layer.paste(grad, (cx - rx, cy - ry), head_mask)
    d = ImageDraw.Draw(layer)

    d.ellipse((cx - rx, cy - ry, cx + rx, cy + ry),
              outline=SHELL_RIM + (face_alpha,), width=max(1, int(2 * s)))
    d.arc((cx - rx + int(3 * s), cy - ry + int(3 * s), cx + rx - int(3 * s), cy + ry - int(3 * s)),
          start=200, end=340, fill=(255, 255, 255, 150), width=max(1, int(2 * s)))

    # Specular highlight, upper-left.
    hl_w, hl_h = int(rx * 0.40), int(ry * 0.26)
    hx, hy = cx - int(rx * 0.42), cy - int(ry * 0.50)
    layer = Image.alpha_composite(layer, _soft_shape(
        layer.size, (255, 255, 255), min(235, face_alpha),
        lambda dd: dd.ellipse(
            (hx - hl_w // 2, hy - hl_h // 2, hx + hl_w // 2, hy + hl_h // 2), fill=255),
        blur_radius=int(6 * s)))
    d = ImageDraw.Draw(layer)

    # --- Eyes ---
    eye_dx = int(rx * 0.42)
    eye_y = cy - int(ry * 0.16) + int(eye_drift * s)
    eye_rx = int(rx * 0.30)
    eye_ry = int(ry * 0.22)

    eyes = Image.new("RGBA", layer.size, (0, 0, 0, 0))
    ed = ImageDraw.Draw(eyes)
    for sign in (-1, 1):
        _eye_shape(ed, cx + sign * eye_dx, eye_y, eye_rx, eye_ry,
                   eye_kind, accent + (255,), s, side=sign)

    if GLOW and ImageFilter is not None and eye_kind != "blink":
        bloom_mask = eyes.getchannel("A").filter(ImageFilter.GaussianBlur(radius=int(8 * s)))
        bloom_mask = bloom_mask.point(lambda v: min(255, int(v * 0.85)))
        bloom = Image.new("RGBA", eyes.size, accent + (0,))
        bloom.putalpha(bloom_mask)
        layer = Image.alpha_composite(layer, bloom)
    layer = Image.alpha_composite(layer, eyes)
    d = ImageDraw.Draw(layer)

    # --- Mouth ---
    _mouth(d, cx, cy + int(ry * 0.46), expr["mouth"], accent + (255,), mouth_phase, s)

    if s > 1:
        layer = layer.resize((W, H), Image.LANCZOS)
    return layer


def draw_face(size, status: str, t: float, face_alpha: int = 255):
    """Render the head as a standalone RGBA layer with a transparent background."""
    if Image is None:
        raise RuntimeError("PIL not installed (install python3-pil)")

    W, H = size
    status = (status or "idle").lower()
    expr = expression_for(status)
    accent = accent_for(status)

    # Blink on a slow cycle, only in restful states.
    blink = (t % 5.4) > 5.18 and status in ("idle", "speaking")
    eye_kind = "blink" if blink else expr["eye"]

    # Mouth animation phase, quantised so it maps onto a cacheable sprite.
    mouth_phase = int((t * 7.0) % 4) if expr["mouth"] == "talk" else 0

    # Thinking: eyes drift as though scanning. Quantised to 3 positions.
    eye_drift = 0
    if status in ("thinking", "transcribing"):
        eye_drift = round(math.sin(t * 2.0) * 2)

    key = (size, status, eye_kind, mouth_phase, eye_drift, face_alpha, SUPERSAMPLE, GLOW)
    sprite = _SPRITE_CACHE.get(key)
    if sprite is None:
        if len(_SPRITE_CACHE) >= _SPRITE_CACHE_MAX:
            _SPRITE_CACHE.clear()
        sprite = _build_face_sprite(size, status, eye_kind, mouth_phase, eye_drift, face_alpha)
        _SPRITE_CACHE[key] = sprite

    # Breathing bob: a translation, so it does not need its own sprite.
    bob = int(round(math.sin(t * 1.6) * 2.2))

    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    layer.paste(sprite, (0, bob))

    # Antenna tip pulses — continuous, but it is one small ellipse.
    d = ImageDraw.Draw(layer)
    cx = W // 2
    cy = H * 0.44 + bob
    ry = W * 0.335
    tip_y = int(cy - ry - 28 + 5)
    pulse = 0.55 + 0.45 * (0.5 + 0.5 * math.sin(t * 2.4))
    tip = tuple(int(c * pulse) for c in accent)
    d.ellipse((cx - 5, tip_y - 5, cx + 5, tip_y + 5), fill=tip + (face_alpha,))

    return layer


def render(size, status: str, t: float, face_alpha: int = 255):
    """Convenience: background + face composited, returned as RGB."""
    W, H = size
    bg = build_background(W, H, accent_for(status)).convert("RGBA")
    face = draw_face(size, status, t, face_alpha=face_alpha)
    return Image.alpha_composite(bg, face).convert("RGB")
