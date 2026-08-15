"""
PocketAgent robot face renderer.

An original mechanical character: a machined chassis with panel seams, bolts and
side actuator modules, a dark inset visor housing glowing optics, and a vocoder
grille that reacts while speaking.

Architecture
------------
The hard constraint is a Pi Zero 2 W driving a 240x280 SPI panel at ~10 FPS, so
nothing expensive may happen per frame.

The trick is separating *structure* from *motion*:

  * Structure (chassis, visor, optics, bolts, vents) never changes shape. It is
    drawn ONCE at SUPERSAMPLE resolution, downscaled, and cached as a sprite.
  * Motion (head tilt, gaze direction, bob, vocoder levels) is applied as cheap
    transforms — a paste offset, a rotation of an already-rendered sprite, a few
    solid rectangles.

That keeps the robot genuinely animated and continuous rather than a handful of
frozen poses, while per-frame cost stays close to a memcpy.

Motion comes from `_motion()`, a small state machine over time: idle sway with
periodic gaze saccades, an alert lean when listening, upward scanning while
thinking, rhythmic nodding while speaking, an excited bounce for reminders, and
a shake for errors.
"""

from __future__ import annotations

import math
import os

try:
    from PIL import Image, ImageDraw, ImageFilter, ImageChops
except Exception:  # pragma: no cover
    Image = ImageDraw = ImageFilter = ImageChops = None


# --- Tunables -----------------------------------------------------------
SUPERSAMPLE = int(os.environ.get("POCKETAGENT_FACE_SUPERSAMPLE", "2"))
GLOW = (os.environ.get("POCKETAGENT_FACE_GLOW", "true").lower() == "true")
MOTION = (os.environ.get("POCKETAGENT_FACE_MOTION", "true").lower() == "true")

# Head rotation is quantised to this many degrees so the rotated-sprite cache
# stays bounded. 1.5 deg is below the point where stepping is visible here.
TILT_STEP = 1.5
TILT_MAX = 7.0

# Metal palette. Deliberately not pure white: a white specular highlight is
# invisible on a white surface, and RGB565 has little headroom at the top.
METAL_HI = (232, 237, 244)
METAL_MID = (188, 196, 208)
METAL_LO = (128, 137, 152)
METAL_EDGE = (74, 82, 96)
SEAM = (108, 117, 132)
BOLT = (150, 159, 173)
BOLT_DARK = (86, 94, 108)

VISOR_BG = (14, 17, 24)
VISOR_RIM = (58, 65, 78)
GRILLE_BG = (38, 43, 54)
GRILLE_OFF = (64, 72, 88)


ACCENTS = {
    "idle":         (120, 230, 130),
    "listening":    (90, 210, 255),
    "transcribing": (255, 200, 90),
    "thinking":     (255, 190, 80),
    "speaking":     (130, 240, 140),
    "reminder":     (255, 165, 70),
    "error":        (255, 105, 105),
}

# Optic shape per status.
#   'round' full lens (alert) | 'happy' upward crescent (content)
#   'slit'  narrow bar (working) | 'cross' X (fault)
OPTICS = {
    "idle":         "happy",
    "listening":    "round",
    "transcribing": "slit",
    "thinking":     "slit",
    "speaking":     "happy",
    "reminder":     "round",
    "error":        "cross",
}


def accent_for(status: str):
    return ACCENTS.get((status or "idle").lower(), ACCENTS["idle"])


def optic_for(status: str):
    return OPTICS.get((status or "idle").lower(), "happy")


# --- Helpers ------------------------------------------------------------

def _soft(size, color, alpha, draw_fn, blur):
    """Blurred solid-colour shape with no dark edge fringing.

    Blurring an RGBA image blurs RGB too, and transparent pixels carry RGB
    (0,0,0) — so the blur drags black into every edge and a white highlight
    comes out grey. Blurring ONLY the alpha channel avoids that.
    """
    mask = Image.new("L", size, 0)
    draw_fn(ImageDraw.Draw(mask))
    if blur > 0 and ImageFilter is not None:
        mask = mask.filter(ImageFilter.GaussianBlur(radius=blur))
    if alpha < 255:
        mask = mask.point(lambda v: (v * alpha) // 255)
    layer = Image.new("RGBA", size, tuple(color) + (0,))
    layer.putalpha(mask)
    return layer


def _vgrad(size, top, bottom, ease=1.0):
    """Vertical gradient (cheap: build one column, then resize)."""
    w, h = size
    col = Image.new("RGB", (1, h))
    px = col.load()
    for i in range(h):
        f = (i / max(1, h - 1)) ** ease
        px[0, i] = tuple(int(top[c] + (bottom[c] - top[c]) * f) for c in range(3))
    return col.resize((w, h))


def _hash01(n: int) -> float:
    """Deterministic pseudo-random in [0,1) — gaze looks unpredictable but is
    identical across reboots, so behaviour is reproducible when debugging."""
    n = (n * 1103515245 + 12345) & 0x7FFFFFFF
    n = ((n ^ (n >> 13)) * 1274126177) & 0x7FFFFFFF
    return (n & 0xFFFF) / 65536.0


# --- Background ---------------------------------------------------------

_BG_CACHE: dict = {}


def build_background(w: int, h: int, accent, seed: int = 7):
    """Dark gradient + starfield + soft accent glow. Cached per accent."""
    if Image is None:
        raise RuntimeError("PIL not installed (install python3-pil)")

    key = (w, h, tuple(accent), seed)
    hit = _BG_CACHE.get(key)
    if hit is not None:
        return hit

    img = _vgrad((w, h), (17, 21, 33), (5, 6, 11), ease=0.85)
    d = ImageDraw.Draw(img)

    rnd = seed
    for _ in range(46):
        rnd = (rnd * 1103515245 + 12345) & 0x7FFFFFFF
        x = rnd % w
        rnd = (rnd * 1103515245 + 12345) & 0x7FFFFFFF
        y = rnd % int(h * 0.8)
        rnd = (rnd * 1103515245 + 12345) & 0x7FFFFFFF
        v = 70 + (rnd % 130)
        d.point((x, y), fill=(v, v, min(255, v + 18)))

    glow = Image.new("RGB", (w, h), (0, 0, 0))
    gx, gy, gr = w // 2, int(h * 0.44), int(w * 0.5)
    ImageDraw.Draw(glow).ellipse((gx - gr, gy - gr, gx + gr, gy + gr),
                                 fill=(accent[0] // 7, accent[1] // 7, accent[2] // 7))
    if ImageFilter is not None:
        glow = glow.filter(ImageFilter.GaussianBlur(radius=28))
    img = ImageChops.screen(img, glow)

    _BG_CACHE[key] = img
    return img


# --- Chassis ------------------------------------------------------------

_CHASSIS_CACHE: dict = {}


def _build_chassis(size, alpha):
    """The static shell: glossy dome head, wraparound visor recess, ear pods,
    collar. Smooth and round — no seams, bolts or hard panel edges.

    Fixed geometry, so it is built once and cached. The visor interior is left
    empty; optics and the speech waveform are composited in per frame so they
    can move independently of the head.
    """
    W, H = size
    s = max(1, SUPERSAMPLE)
    L = Image.new("RGBA", (W * s, H * s), (0, 0, 0, 0))
    d = ImageDraw.Draw(L)

    cx = (W // 2) * s
    cy = int(H * 0.42 * s)
    rx = int(W * 0.335 * s)      # slightly wider than tall
    ry = int(W * 0.320 * s)
    lw = max(1, int(2 * s))

    # --- Contact shadow --------------------------------------------------
    # A soft shadow under the dome grounds it far better than a neck stub,
    # which just reads as a nub hanging off the bottom.
    L = Image.alpha_composite(L, _soft(
        L.size, (0, 0, 0), min(120, alpha),
        lambda dd: dd.ellipse((cx - int(rx * 0.72), cy + ry - int(2 * s),
                               cx + int(rx * 0.72), cy + ry + int(16 * s)), fill=255),
        blur=int(9 * s)))
    d = ImageDraw.Draw(L)

    # --- Ear pods --------------------------------------------------------
    # Headphone-style discs that overlap the dome edge, matching the soft
    # rounded language of the shell.
    for sign in (-1, 1):
        ex = cx + sign * int(rx * 0.97)
        er = int(ry * 0.30)
        d.ellipse((ex - er, cy - er, ex + er, cy + er), fill=METAL_HI + (alpha,))
        d.ellipse((ex - er, cy - er, ex + er, cy + er),
                  outline=(150, 160, 176, alpha), width=max(1, int(1.5 * s)))
        rr = int(er * 0.58)
        d.ellipse((ex - rr, cy - rr, ex + rr, cy + rr), fill=(40, 46, 58, alpha))
        rr2 = int(er * 0.26)
        d.ellipse((ex - rr2, cy - rr2, ex + rr2, cy + rr2), fill=(74, 84, 100, alpha))

    # --- Dome ------------------------------------------------------------
    d.ellipse((cx - rx, cy - ry, cx + rx, cy + ry), fill=METAL_HI + (alpha,))

    dome_mask = Image.new("L", (2 * rx, 2 * ry), 0)
    ImageDraw.Draw(dome_mask).ellipse((0, 0, 2 * rx - 1, 2 * ry - 1), fill=255)
    grad = _vgrad((2 * rx, 2 * ry), METAL_HI, METAL_LO, ease=2.1).convert("RGBA")
    L.paste(grad, (cx - rx, cy - ry), dome_mask)
    d = ImageDraw.Draw(L)

    # Soft occlusion around the lower rim so the dome reads as a sphere.
    L = Image.alpha_composite(L, _soft(
        L.size, (60, 68, 84), min(150, alpha),
        lambda dd: dd.arc((cx - rx + int(2 * s), cy - ry + int(2 * s),
                           cx + rx - int(2 * s), cy + ry - int(2 * s)),
                          start=15, end=165, fill=255, width=int(9 * s)),
        blur=int(7 * s)))
    d = ImageDraw.Draw(L)

    # --- Visor recess ----------------------------------------------------
    # Wide wraparound lozenge: the single most important cue that this is a
    # smooth robot rather than a boxy one.
    vx0, vx1 = cx - int(rx * 0.84), cx + int(rx * 0.84)
    vy0, vy1 = cy - int(ry * 0.34), cy + int(ry * 0.36)
    vr = int((vy1 - vy0) * 0.48)
    d.rounded_rectangle((vx0, vy0, vx1, vy1), radius=vr, fill=VISOR_BG + (alpha,))

    # Glass sheen: a soft diagonal band across the upper half of the visor,
    # clipped to the visor so it reads as reflection on curved glass.
    vmask = Image.new("L", L.size, 0)
    ImageDraw.Draw(vmask).rounded_rectangle((vx0, vy0, vx1, vy1), radius=vr, fill=255)
    sheen = _soft(L.size, (150, 175, 205), min(70, alpha),
                  lambda dd: dd.ellipse((vx0 - int(10 * s), vy0 - int(26 * s),
                                         cx + int(rx * 0.30), vy0 + int(16 * s)), fill=255),
                  blur=int(8 * s))
    sheen.putalpha(ImageChops.multiply(sheen.getchannel("A"), vmask))
    L = Image.alpha_composite(L, sheen)
    d = ImageDraw.Draw(L)

    # Thin bright rim on the visor edge — catches light like a bezel.
    d.rounded_rectangle((vx0, vy0, vx1, vy1), radius=vr,
                        outline=(120, 132, 152, min(alpha, 170)), width=lw)

    # --- Specular highlight on the dome ----------------------------------
    L = Image.alpha_composite(L, _soft(
        L.size, (255, 255, 255), min(200, alpha),
        lambda dd: dd.ellipse((cx - int(rx * 0.66), cy - int(ry * 0.92),
                               cx - int(rx * 0.06), cy - int(ry * 0.46)), fill=255),
        blur=int(10 * s)))

    # Small secondary glint, upper right.
    L = Image.alpha_composite(L, _soft(
        L.size, (255, 255, 255), min(120, alpha),
        lambda dd: dd.ellipse((cx + int(rx * 0.40), cy - int(ry * 0.76),
                               cx + int(rx * 0.66), cy - int(ry * 0.58)), fill=255),
        blur=int(5 * s)))

    if s > 1:
        L = L.resize((W, H), Image.LANCZOS)

    geom = {
        "cx": W / 2.0,
        "cy": cy / s,
        "hw": rx / s,
        "hh": ry / s,
        "visor": (vx0 / s, vy0 / s, vx1 / s, vy1 / s),
    }
    return L, geom


def chassis(size, alpha):
    key = (size, alpha, SUPERSAMPLE)
    hit = _CHASSIS_CACHE.get(key)
    if hit is None:
        hit = _build_chassis(size, alpha)
        _CHASSIS_CACHE[key] = hit
    return hit


# --- Optics -------------------------------------------------------------

_OPTIC_CACHE: dict = {}


def _build_optic(kind, accent, w, h):
    """One glowing optic with its bloom, on a transparent tile.

    Cached and pasted at a moving offset — that is what lets the gaze drift
    smoothly without re-rendering or re-blurring anything per frame.
    """
    s = max(1, SUPERSAMPLE)
    pad = int(12 * s)
    tw, th = int(w * s) + pad * 2, int(h * s) + pad * 2
    tile = Image.new("RGBA", (tw, th), (0, 0, 0, 0))
    d = ImageDraw.Draw(tile)

    cx, cy = tw // 2, th // 2
    rx, ry = int(w * s) // 2, int(h * s) // 2
    a = tuple(accent) + (255,)

    if kind == "round":
        d.ellipse((cx - rx, cy - ry, cx + rx, cy + ry), fill=a)
        d.ellipse((cx - rx // 2, cy - ry // 2, cx + rx // 2, cy + ry // 2),
                  outline=(255, 255, 255, 140), width=max(1, int(2 * s)))
    elif kind == "happy":
        d.arc((cx - rx, cy - ry, cx + rx, cy + ry * 2),
              start=190, end=350, fill=a, width=max(2, int(7 * s)))
    elif kind == "slit":
        d.rounded_rectangle((cx - rx, cy - int(ry * 0.30), cx + rx, cy + int(ry * 0.30)),
                            radius=max(1, int(ry * 0.30)), fill=a)
    elif kind == "cross":
        tw_ = max(2, int(5 * s))
        d.line((cx - rx, cy - ry // 2, cx + rx, cy + ry // 2), fill=a, width=tw_)
        d.line((cx - rx, cy + ry // 2, cx + rx, cy - ry // 2), fill=a, width=tw_)
    else:  # blink — closed shutter
        d.rounded_rectangle((cx - rx, cy - int(2.5 * s), cx + rx, cy + int(2.5 * s)),
                            radius=max(1, int(2 * s)), fill=a)

    if GLOW and ImageFilter is not None and kind != "blink":
        m = tile.getchannel("A").filter(ImageFilter.GaussianBlur(radius=int(7 * s)))
        m = m.point(lambda v: min(255, int(v * 0.9)))
        bloom = Image.new("RGBA", tile.size, tuple(accent) + (0,))
        bloom.putalpha(m)
        tile = Image.alpha_composite(bloom, tile)

    if s > 1:
        tile = tile.resize((tw // s, th // s), Image.LANCZOS)
    return tile


def optic(kind, accent, w, h):
    key = (kind, tuple(accent), w, h, SUPERSAMPLE, GLOW)
    hit = _OPTIC_CACHE.get(key)
    if hit is None:
        hit = _build_optic(kind, accent, w, h)
        _OPTIC_CACHE[key] = hit
    return hit


# --- Rotation ------------------------------------------------------------
# Rotating the fully-composed head every frame costs ~7 ms (BICUBIC) at 240x280,
# which is the entire frame budget on a Pi Zero 2 W. Instead we rotate the
# *static* chassis once per quantised angle and cache it, rotate only small
# sprite tiles per frame, and place moving parts by rotating their coordinates.

_ROT_CHASSIS: dict = {}
_ROT_TILE: dict = {}


def _rot_pt(x, y, cx, cy, deg):
    """Where a feature at (x, y) ends up after the head is tilted `deg` about
    (cx, cy). Screen y grows downward, hence the sign convention here."""
    a = math.radians(deg)
    ca, sa = math.cos(a), math.sin(a)
    dx, dy = x - cx, y - cy
    return cx + dx * ca + dy * sa, cy - dx * sa + dy * ca


def _quantise(deg):
    return round(deg / TILT_STEP) * TILT_STEP


def rotated_chassis(size, alpha, deg, pivot):
    key = (size, alpha, deg, SUPERSAMPLE)
    hit = _ROT_CHASSIS.get(key)
    if hit is None:
        body, _ = chassis(size, alpha)
        if abs(deg) < 0.01:
            hit = body
        else:
            hit = body.rotate(deg, resample=Image.BICUBIC, center=pivot)
        if len(_ROT_CHASSIS) > 32:
            _ROT_CHASSIS.clear()
        _ROT_CHASSIS[key] = hit
    return hit


def rotated_tile(tile, deg, key):
    """Rotate a small sprite, cached. Small tiles are cheap enough that BICUBIC
    is affordable here even though it is not on the full frame."""
    ck = (key, deg)
    hit = _ROT_TILE.get(ck)
    if hit is None:
        hit = tile if abs(deg) < 0.01 else tile.rotate(
            deg, resample=Image.BICUBIC, expand=True)
        if len(_ROT_TILE) > 96:
            _ROT_TILE.clear()
        _ROT_TILE[ck] = hit
    return hit


# --- Motion -------------------------------------------------------------

def _saccade(t, period, ax, ay):
    """Gaze that holds a target for a beat then flicks to a new one, rather
    than sliding around continuously — real eyes move in jumps."""
    i = int(t / period)
    f = (t / period) - i
    e = min(1.0, f * 6.0)  # fast ease into the new target, then hold
    x1, y1 = (_hash01(i * 2) - 0.5) * 2, (_hash01(i * 2 + 1) - 0.5) * 2
    x0, y0 = (_hash01((i - 1) * 2) - 0.5) * 2, (_hash01((i - 1) * 2 + 1) - 0.5) * 2
    return (x0 + (x1 - x0) * e) * ax, (y0 + (y1 - y0) * e) * ay


def _motion(status, t):
    """Continuous motion state for this instant.

    Each status has its own movement character, so the device's state is
    legible from body language alone, before you read the status pill.
    """
    if not MOTION:
        return {"tilt": 0.0, "gx": 0.0, "gy": 0.0, "bob": 0.0, "energy": 0.0}

    tilt = gx = gy = bob = 0.0
    energy = 0.0

    if status == "idle":
        tilt = math.sin(t * 0.55) * 4.0
        bob = math.sin(t * 1.1) * 2.0
        gx, gy = _saccade(t, 2.7, 5.0, 2.5)

    elif status == "listening":
        tilt = math.sin(t * 2.2) * 1.6
        bob = -2.0 + math.sin(t * 2.6) * 0.8
        gx, gy = _saccade(t, 1.1, 3.0, 1.5)

    elif status in ("thinking", "transcribing"):
        tilt = -3.0 + math.sin(t * 0.9) * 3.5
        gx = math.sin(t * 0.8) * 5.0
        gy = -3.0 + math.sin(t * 1.7) * 1.5
        bob = math.sin(t * 0.7) * 1.2

    elif status == "speaking":
        tilt = math.sin(t * 3.1) * 2.6
        bob = math.sin(t * 6.2) * 1.6
        gx, gy = _saccade(t, 1.8, 3.0, 1.5)
        energy = 0.5 + 0.5 * math.sin(t * 11.0) * math.sin(t * 4.3)

    elif status == "reminder":
        bob = -abs(math.sin(t * 5.0)) * 5.0
        tilt = math.sin(t * 5.0) * 5.0
        energy = 0.7

    elif status == "error":
        tilt = math.sin(t * 18.0) * 4.0
        gx = math.sin(t * 18.0) * 2.0
        bob = 2.0

    return {
        "tilt": max(-TILT_MAX, min(TILT_MAX, tilt)),
        "gx": gx, "gy": gy, "bob": bob,
        "energy": max(0.0, min(1.0, energy)),
    }


# --- Public API ---------------------------------------------------------

def _wave_tile(geom, status, accent, energy, t, alpha):
    """Speech waveform, rendered inside the visor beneath the optics.

    These rounded designs have no mouth, so speech is shown as a small glowing
    waveform on the visor instead of an external grille — it keeps the shell
    smooth and unbroken.

    Kept as a standalone tile so it can be rotated with the head cheaply: the
    tile is tiny compared to the full frame.
    """
    vx0, vy0, vx1, vy1 = geom["visor"]
    tw = int((vx1 - vx0) * 0.46)
    th = max(6, int((vy1 - vy0) * 0.24))
    tile = Image.new("RGBA", (max(1, tw), th), (0, 0, 0, 0))
    if energy <= 0.02 and status not in ("listening", "reminder"):
        return tile

    d = ImageDraw.Draw(tile)
    N = 9
    gap = tw / N
    col = tuple(accent) + (alpha,)
    for i in range(N):
        centre = 1.0 - abs(i - (N - 1) / 2) / ((N - 1) / 2)
        wob = 0.5 + 0.5 * math.sin(t * 15.0 + i * 1.3)
        lvl = energy * (0.30 + 0.70 * centre) * wob
        if status in ("listening", "reminder"):
            lvl = max(lvl, 0.22 + 0.20 * wob)
        h = max(1.5, (th - 2) * lvl)
        x = i * gap + gap * 0.5
        d.rounded_rectangle((x - gap * 0.28, th / 2 - h / 2,
                             x + gap * 0.28, th / 2 + h / 2),
                            radius=gap * 0.28, fill=col)
    return tile


def _paste_centred(dst, tile, cxy):
    dst.alpha_composite(tile, (int(cxy[0] - tile.width / 2),
                               int(cxy[1] - tile.height / 2)))


def draw_face(size, status: str, t: float, face_alpha: int = 255):
    """Render the robot as an RGBA layer with a transparent background."""
    if Image is None:
        raise RuntimeError("PIL not installed (install python3-pil)")

    W, H = size
    status = (status or "idle").lower()
    accent = accent_for(status)
    m = _motion(status, t)

    _, geom = chassis(size, face_alpha)
    cx, cy = geom["cx"], geom["cy"]
    hw, hh = geom["hw"], geom["hh"]

    # Pivot at the neck joint so the head swivels like it is on a servo rather
    # than spinning about its own centre.
    pivot = (int(cx), int(cy + hh))
    tilt = _quantise(m["tilt"])

    head = rotated_chassis(size, face_alpha, tilt, pivot).copy()

    # --- Optics ----------------------------------------------------------
    blink = (t % 5.6) > 5.42 and status in ("idle", "speaking", "listening")
    kind = "blink" if blink else optic_for(status)

    ow, oh = int(hw * 0.40), int(hh * 0.34)
    eye = rotated_tile(optic(kind, accent, ow, oh), tilt,
                       ("optic", kind, tuple(accent), ow, oh))
    eye_dx = hw * 0.36
    eye_y = cy - hh * 0.10 + m["gy"]
    for sign in (-1, 1):
        p = _rot_pt(cx + sign * eye_dx + m["gx"], eye_y, pivot[0], pivot[1], tilt)
        _paste_centred(head, eye, p)

    # --- Speech waveform (on the visor, below the optics) ----------------
    vx0, vy0, vx1, vy1 = geom["visor"]
    wave = _wave_tile(geom, status, accent, m["energy"], t, face_alpha)
    if abs(tilt) > 0.01:
        wave = wave.rotate(tilt, resample=Image.BICUBIC, expand=True)
    _paste_centred(head, wave,
                   _rot_pt(cx, vy1 - (vy1 - vy0) * 0.22, pivot[0], pivot[1], tilt))

    # --- Bob -------------------------------------------------------------
    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    out.paste(head, (0, int(round(m["bob"]))))
    return out


def render(size, status: str, t: float, face_alpha: int = 255):
    """Convenience: background + robot composited, returned as RGB."""
    W, H = size
    bg = build_background(W, H, accent_for(status)).convert("RGBA")
    return Image.alpha_composite(bg, draw_face(size, status, t, face_alpha)).convert("RGB")
