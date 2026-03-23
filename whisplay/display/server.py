#!/usr/bin/env python3
"""Whisplay display sidecar for PocketAgent.

# head + ear pads (match reference style)

cx, cy = (W // 2, 110 + bob_y)  # TEMP DEBUG: move face up


# head: slightly wider than tall (like reference)
    rx, ry = 76, 64
d.ellipse((cx - rx, cy - ry, cx + rx, cy + ry), fill=(255, 255, 255))


# ear pads: flat inner edge, rounded outer edge, slight gap from head
    pad_w, pad_h = 14, 44
    gap = 10
# left pad: flat edge at inner_x, rounded outer with half-ellipse

inner_x = cx - rx - gap

outer_x = inner_x - pad_w

top_y = cy - pad_h // 2

bot_y = cy + pad_h // 2

d.rectangle((outer_x + pad_w//2, top_y, inner_x, bot_y), fill=(255, 255, 255))

d.ellipse((outer_x, top_y, outer_x + pad_w, bot_y), fill=(255, 255, 255))


# right pad

inner_x = cx + rx + gap

outer_x = inner_x + pad_w

d.rectangle((inner_x, top_y, outer_x - pad_w//2, bot_y), fill=(255, 255, 255))

d.ellipse((outer_x - pad_w, top_y, outer_x, bot_y), fill=(255, 255, 255))


# eyes:
# mouth (simple)

mx0, my0, mx1, my1 = (92, 170 + bob_y, 148, 196 + bob_y)

# small smile line (white)

d.arc((mx0, my0, mx1, my1), start=20, end=160, fill=(255, 255, 255), width=4)


# subtitle bubble
Goals:
- dead-simple integration: PocketAgent POSTs events to localhost
- render a basic status UI + last assistant text + next reminder
- use PiSugar's Whisplay driver if available; otherwise run in "stdout" mode

This is intentionally small and dependency-light.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

# Pillow is installed by install_pi.sh (python3-pil)
# PIL is optional at import time so the service can still start in stdout mode.
try:
    from PIL import Image, ImageDraw, ImageFont
except Exception:  # pragma: no cover
    Image = ImageDraw = ImageFont = None  # type: ignore

HOST = os.environ.get("POCKETAGENT_DISPLAY_HOST", "127.0.0.1")
PORT = int(os.environ.get("POCKETAGENT_DISPLAY_PORT", "3782"))

MODE = os.environ.get("POCKETAGENT_DISPLAY_MODE", "auto")  # auto|whisplay|stdout|off

state = {
    "updatedAt": None,
    "status": "idle",  # idle|listening|transcribing|thinking|speaking|reminder|error
    "line1": "PocketAgent",
    "line2": "",
    "line3": "",
    "line4": "",
    "next": "",

    # Optional wifi indicator (if set by the agent)
    # wifi: { rssiDbm: -50, bars: 3, ssid: "IoT" }
    "wifi": None,

    # Optional battery indicator (if set by the agent)
    # battery: { percent: 73, charging: false, plugged: true }
    "battery": None,
}

# Animation settings
W, H = 240, 280

# Optional background image (e.g. hyperion.jpg)
BG_IMAGE_PATH = os.environ.get(
    "POCKETAGENT_DISPLAY_BG_IMAGE",
    os.path.join(os.path.dirname(__file__), "assets", "hyperion.jpg"),
)

_BG_CACHE = {"path": None, "img": None}

def _load_bg_image():
    if Image is None:
        return None
    p = BG_IMAGE_PATH
    if not p or not os.path.exists(p):
        return None
    if _BG_CACHE.get("path") == p and _BG_CACHE.get("img") is not None:
        return _BG_CACHE["img"]
    try:
        im = Image.open(p).convert("RGB")
        _BG_CACHE["path"] = p
        _BG_CACHE["img"] = im
        return im
    except Exception:
        _BG_CACHE["path"] = p
        _BG_CACHE["img"] = None
        return None


def _fit_cover(img, w: int, h: int):
    """Resize/crop to cover target size (like CSS background-size: cover)."""
    if img is None:
        return None
    iw, ih = img.size
    if iw <= 0 or ih <= 0:
        return None
    scale = max(w / iw, h / ih)
    nw, nh = int(iw * scale + 0.5), int(ih * scale + 0.5)
    im2 = img.resize((nw, nh))
    x0 = max(0, (nw - w) // 2)
    y0 = max(0, (nh - h) // 2)
    return im2.crop((x0, y0, x0 + w, y0 + h))

ACTIVE_FPS = float(os.environ.get("POCKETAGENT_DISPLAY_FPS_ACTIVE", "10"))
IDLE_FPS = float(os.environ.get("POCKETAGENT_DISPLAY_FPS_IDLE", "1"))
SUBTITLE_MAX_CHARS = int(os.environ.get("POCKETAGENT_DISPLAY_SUBTITLE_MAX_CHARS", "80"))

# Simple coalescing so rapid /update calls don't cause redraw storms
_state_lock = threading.Lock()
_state_dirty = True
_last_render_status = None
_last_frame_at = 0.0

# Render thread control
_stop = False

# Sleep settings (backlight only; we still render frames)
SLEEP_SECS = float(os.environ.get("POCKETAGENT_DISPLAY_SLEEP_SECS", "0") or "0")
# Backlight to restore on wake (defaults to current configured backlight env or 60)
WAKE_BACKLIGHT = int(os.environ.get("POCKETAGENT_DISPLAY_WAKE_BACKLIGHT", os.environ.get("POCKETAGENT_DISPLAY_BACKLIGHT", "60")))

_last_update_at = time.time()


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class DisplayBackend:
    def present(self, s: dict):
        raise NotImplementedError


def _load_font(size: int, bold: bool = False):
    if ImageFont is None:
        return None
    # DejaVu is usually present on Pi OS. Fall back to PIL default.
    paths = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf" if bold else "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
    ]
    for p in paths:
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            continue
    try:
        return ImageFont.load_default()
    except Exception:
        return None


_FONT_STATUS = _load_font(14, bold=True)
_FONT_SUB = _load_font(14, bold=False)


def _wrap_text(draw: ImageDraw.ImageDraw, text: str, font, max_width: int, max_lines: int = 2, ellipsize: bool = True):
    """Word-wrap text into up to max_lines.

    If ellipsize=True, the last line is truncated with an ellipsis to fit.
    """
    text = (text or "").strip()
    if not text:
        return []
    words = text.split()
    lines = []
    line = ""
    for w in words:
        test = (line + " " + w).strip()
        if draw.textlength(test, font=font) <= max_width:
            line = test
        else:
            if line:
                lines.append(line)
            line = w
            if len(lines) >= max_lines:
                break
    if line and len(lines) < max_lines:
        lines.append(line)

    if ellipsize and lines:
        last = lines[-1]
        while draw.textlength(last, font=font) > max_width and len(last) > 1:
            last = last[:-2].rstrip() + "…"
        lines[-1] = last
    return lines


def _wrap_text_all(draw: ImageDraw.ImageDraw, text: str, font, max_width: int):
    """Word-wrap text into as many lines as needed (no ellipsize)."""
    text = (text or "").strip()
    if not text:
        return []

    words = text.split()
    lines = []
    line = ""

    for w in words:
        test = (line + " " + w).strip()
        if not line:
            line = w
            continue

        if draw.textlength(test, font=font) <= max_width:
            line = test
        else:
            lines.append(line)
            line = w

    if line:
        lines.append(line)

    # Safety: cap runaway line counts
    return lines[:200]


def _bg_color_for(status: str):
    status = (status or "idle").lower()
    # Pixar-ish pastel palette
    return {
        "idle": ((170, 205, 255), (200, 225, 255), (175, 200, 255)),
        "listening": ((175, 245, 220), (210, 255, 245), (185, 240, 220)),
        "transcribing": ((255, 245, 190), (255, 250, 220), (255, 238, 190)),
        "thinking": ((185, 210, 255), (215, 232, 255), (190, 205, 255)),
        "speaking": ((225, 200, 255), (238, 220, 255), (215, 190, 255)),
        "reminder": ((255, 210, 180), (255, 228, 205), (255, 200, 175)),
        "error": ((255, 190, 190), (255, 215, 215), (255, 175, 175)),
    }.get(status, ((170, 205, 255), (200, 225, 255), (175, 200, 255)))


def render_frame(s: dict, t: float):
    """Render a single 240x280 frame as a PIL image."""
    if Image is None or ImageDraw is None:
        raise RuntimeError("PIL not installed (install python3-pil)")

    status = (s.get("status") or "idle").lower()

    # Build as RGBA so we can alpha-blend UI/face over the background.
    img = Image.new("RGBA", (W, H), (0, 0, 0, 255))

    # Background
    bg = _fit_cover(_load_bg_image(), W, H)
    if bg is not None:
        img.paste(bg.convert("RGBA"), (0, 0))
        # Add a subtle dark overlay so UI/face remain readable.
        overlay_alpha = int(os.environ.get("POCKETAGENT_DISPLAY_BG_DARKEN", "70"))  # 0-255
        if overlay_alpha > 0:
            ov = Image.new("RGBA", (W, H), (0, 0, 0, max(0, min(255, overlay_alpha))))
            img = Image.alpha_composite(img, ov)
    else:
        # fallback: solid black
        d0 = ImageDraw.Draw(img)
        d0.rectangle((0, 0, W, H), fill=(0, 0, 0, 255))

    # UI overlay (face + bubbles) with configurable transparency
    face_alpha = int(os.environ.get("POCKETAGENT_DISPLAY_FACE_ALPHA", "235"))  # 0-255
    bubble_alpha = int(os.environ.get("POCKETAGENT_DISPLAY_BUBBLE_ALPHA", "240"))  # 0-255
    outline_alpha = int(os.environ.get("POCKETAGENT_DISPLAY_OUTLINE_ALPHA", "220"))  # 0-255

    ui = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(ui)
    # wifi indicator (top-left)
    wifi = s.get("wifi") or {}
    connected = bool(wifi.get("connected"))
    try:
        bars = int(wifi.get("bars") or 0)
    except Exception:
        bars = 0
    bars = max(0, min(4, bars))

    # Draw iPhone-like bars
    x0, y0 = (14, 16)
    bar_w, gap = (4, 2)
    for i in range(4):
        h = 4 + i * 4
        x = x0 + i * (bar_w + gap)
        y = y0 + (16 - h)
        col = (255, 255, 255, 240) if (connected and i < bars) else (255, 255, 255, 90)
        d.rounded_rectangle((x, y, x + bar_w, y + h), radius=2, fill=col)

    # If not connected, draw a slash through the bars
    if not connected:
        d.line((x0 - 2, y0 + 14, x0 + 4 * (bar_w + gap), y0 - 2), fill=(255, 255, 255, 200), width=3)

    # battery indicator (top-right)
    bat = s.get("battery") or {}
    try:
        pct = int(round(float(bat.get("percent")))) if bat.get("percent") is not None else None
    except Exception:
        pct = None
    plugged = bool(bat.get("plugged"))
    charging = bool(bat.get("charging"))

    if pct is not None:
        pct = max(0, min(100, pct))
        # Battery outline box (tuned to align with Wi‑Fi bars)
        # Slightly smaller and nudged down/right.
        bx, by = (W - 45, 20)
        bw, bh = (30, 14)
        # main body
        d.rounded_rectangle((bx, by, bx + bw, by + bh), radius=4, outline=(255, 255, 255, 220), width=2, fill=(0, 0, 0, 0))
        # cap
        d.rounded_rectangle((bx + bw, by + 4, bx + bw + 4, by + 10), radius=2, outline=(255, 255, 255, 220), width=2, fill=(0, 0, 0, 0))

        # fill
        inner_pad = 3
        fill_w = int((bw - 2 * inner_pad) * (pct / 100.0))
        # Color rules:
        # - green: >= 20%
        # - yellow: < 20%
        # - red: < 10%
        fill_col = (255, 140, 140, 230) if pct < 10 else (255, 210, 120, 220) if pct < 20 else (120, 255, 160, 220)
        d.rounded_rectangle(
            (bx + inner_pad, by + inner_pad, bx + inner_pad + max(1, fill_w), by + bh - inner_pad),
            radius=3,
            fill=fill_col,
        )

        # (no percent text — icon only)

        # small bolt overlay when charging
        if plugged and charging:
            # simple lightning bolt shape inside battery
            bolt = [
                (bx + 13, by + 2),
                (bx + 10, by + 8),
                (bx + 14, by + 8),
                (bx + 11, by + 12),
                (bx + 19, by + 6),
                (bx + 15, by + 6),
            ]
            d.polygon(bolt, fill=(255, 255, 255, 220))

    # status pill
    label = (status or "idle").upper()
    pill = (60, 14, 180, 38)
    d.rounded_rectangle(
        pill,
        radius=12,
        fill=(255, 255, 255, bubble_alpha),
        outline=(220, 230, 255, outline_alpha),
        width=2,
    )
    if _FONT_STATUS is not None:
        tw = d.textlength(label, font=_FONT_STATUS)
        d.text(((W - tw) // 2, 18), label, font=_FONT_STATUS, fill=(60, 80, 120))
    bob_y = 0

    # Eyes + face (minimal, black/white) — keep UI elements elsewhere

    blink_phase = (t % 6.0)

    blinking = 5.6 < blink_phase < 5.9 and status == "idle"


    # head + ear pads (reference-style)
    cx, cy = (W // 2, 140 + bob_y)
    # head: slightly wider than tall
    rx, ry = 80, 68
    d.ellipse((cx - rx, cy - ry, cx + rx, cy + ry), fill=(255, 255, 255, face_alpha))

    # ear pads: flat inner edge, rounded outer edge, with a gap from the head
    pad_w, pad_h = 16, 50
    gap = 10
    top_y = cy - pad_h // 2
    bot_y = cy + pad_h // 2

    # left ear (flat inner wall at inner_x, rounded outer dome)
    inner_x = cx - rx - gap
    outer_x = inner_x - pad_w
    d.rectangle((outer_x + pad_w//2, top_y, inner_x, bot_y), fill=(255, 255, 255, face_alpha))
    d.ellipse((outer_x, top_y, outer_x + pad_w, bot_y), fill=(255, 255, 255, face_alpha))

    # right ear
    inner_x = cx + rx + gap
    outer_x = inner_x + pad_w
    d.rectangle((inner_x, top_y, outer_x - pad_w//2, bot_y), fill=(255, 255, 255, face_alpha))
    d.ellipse((outer_x - pad_w, top_y, outer_x, bot_y), fill=(255, 255, 255, face_alpha))

    # eyes: spherical circles + single highlight dot
    eye_r = 26
    eye_dx = 37
    eye_y  = cy - 22

    for ex in (cx - eye_dx, cx + eye_dx):
        if blinking:
            d.rounded_rectangle((ex - eye_r, eye_y - 4, ex + eye_r, eye_y + 4), radius=8, fill=(0, 0, 0))
        else:
            d.ellipse((ex - eye_r, eye_y - eye_r, ex + eye_r, eye_y + eye_r), fill=(0, 0, 0))
            hl_r = 8
            hx, hy = ex - 12, eye_y - 12
            d.ellipse((hx - hl_r, hy - hl_r, hx + hl_r, hy + hl_r), fill=(255, 255, 255))

    # mouth: animate while speaking (simple cycle)
    mx0, my0, mx1, my1 = (cx - 26, cy + 27, cx + 26, cy + 51)

    if status == "speaking":
        phase = int((t * 10) % 4)
        if phase == 0:
            # small smile
            d.arc((mx0, my0, mx1, my1), start=20, end=160, fill=(0, 0, 0), width=5)
        elif phase == 1:
            # flat line
            d.rounded_rectangle((cx - 18, cy + 40, cx + 18, cy + 44), radius=3, fill=(0, 0, 0))
        elif phase == 2:
            # open mouth
            d.ellipse((cx - 10, cy + 34, cx + 10, cy + 50), outline=(0, 0, 0), width=5)
        else:
            # wider open mouth
            d.ellipse((cx - 14, cy + 34, cx + 14, cy + 50), outline=(0, 0, 0), width=5)
    else:
        # idle/default: small smile
        d.arc((mx0, my0, mx1, my1), start=20, end=160, fill=(0, 0, 0), width=5)

    # subtitle bubble

    subtitle_full = (s.get("line2") or s.get("next") or "").strip()

    # While speaking, vertically scroll the assistant text (like a normal chat transcript).
    subtitle = ""
    subtitle_scrolling = False
    scroll_lines = []

    if subtitle_full:
        subtitle = subtitle_full

        if status == "speaking" and len(subtitle_full) > int(os.environ.get("POCKETAGENT_DISPLAY_SCROLL_MIN_CHARS", "40")):
            subtitle_scrolling = True

            # Wrap full text to bubble width (no ellipsize), then scroll by line.
            max_width = 190
            all_lines = _wrap_text_all(d, subtitle_full, _FONT_SUB, max_width=max_width)

            # Visible lines in bubble: 2 lines (y=242,258). You can bump to 3 if you reduce font.
            visible = int(os.environ.get("POCKETAGENT_DISPLAY_SCROLL_VISIBLE_LINES", "2"))
            visible = max(1, min(6, visible))

            # Scroll speed: lines/sec
            start_delay = 0.6
            lps = float(os.environ.get("POCKETAGENT_DISPLAY_SCROLL_LPS", "1.0"))
            t2 = max(0.0, t - start_delay)
            line_offset = int(t2 * lps)

            if len(all_lines) <= visible:
                subtitle_scrolling = False
            else:
                # Loop with a small blank gap
                gap = [""]
                loop = all_lines + gap
                line_offset = line_offset % len(loop)
                loop2 = loop + loop
                scroll_lines = loop2[line_offset : line_offset + visible]

    if not subtitle and not subtitle_scrolling:
        subtitle = "ready" if status == "idle" else ""

    # Subtitle bubble (leave a little extra vertical room so descenders (g/j/p/q/y) don't clip)
    sub = (20, 232, 220, 276)
    d.rounded_rectangle(
        sub,
        radius=16,
        fill=(255, 255, 255, bubble_alpha),
        outline=(220, 230, 255, outline_alpha),
        width=2,
    )

    if _FONT_SUB is not None:
        if subtitle_scrolling and scroll_lines:
            y0 = 238
            line_h = 16
            for i, ln in enumerate(scroll_lines):
                d.text((30, y0 + i * line_h), ln, font=_FONT_SUB, fill=(60, 80, 120))
        else:
            lines = _wrap_text(d, subtitle, _FONT_SUB, max_width=190, max_lines=2, ellipsize=True)
            y = 238
            for ln in lines:
                d.text((30, y), ln, font=_FONT_SUB, fill=(60, 80, 120))
                y += 16

    # Composite UI onto background and return as RGB for downstream conversion.
    img = Image.alpha_composite(img, ui)
    return img.convert("RGB")


def rgb888_to_rgb565_bytes(img) -> bytes:
    """Convert PIL RGB image to RGB565 big-endian byte stream (as used by PiSugar examples)."""
    img = img.convert("RGB")
    px = img.load()
    out = bytearray()
    for y in range(H):
        for x in range(W):
            r, g, b = px[x, y]
            rgb565 = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)
            out.append((rgb565 >> 8) & 0xFF)
            out.append(rgb565 & 0xFF)
    return bytes(out)


def is_active_status(status: str) -> bool:
    return (status or "idle").lower() in {"listening", "transcribing", "thinking", "speaking", "reminder", "error"}


def subtitle_from_state(s: dict) -> str:
    # Prefer explicit assistant text in line2, else next reminder.
    t = (s.get("line2") or "").strip()
    if t:
        return t
    n = (s.get("next") or "").strip()
    if n:
        return n
    return ""



class StdoutBackend(DisplayBackend):
    def __init__(self):
        self._last = None

    def present(self, s: dict):
        # basic "poor man's" UI for dev/CI (only when state changes)
        key = json.dumps(s, sort_keys=True, ensure_ascii=False)
        if key == self._last:
            return
        self._last = key
        sys.stdout.write("\n[display] " + key + "\n")
        sys.stdout.flush()


class WhisplayBackend(DisplayBackend):
    def __init__(self):
        self.ok = False
        self.board = None
        self._asleep = False
        self._last_bl = None
        self._init_driver()

    def _init_driver(self):
        try:
            # Prefer local vendored driver if present
            sys.path.insert(0, os.environ.get("WHISPLAY_DRIVER_PATH", "/opt/Whisplay/Driver"))
            from WhisPlay import WhisPlayBoard  # type: ignore

            self.board = WhisPlayBoard()
            try:
                # reasonable default backlight
                bl = WAKE_BACKLIGHT
                self.board.set_backlight(bl)
                self._last_bl = bl
            except Exception:
                pass
            self.ok = True
        except Exception as e:
            sys.stdout.write(f"[display] Whisplay backend unavailable: {e}\n")
            sys.stdout.flush()
            self.ok = False

    def _set_backlight(self, value: int):
        try:
            self.board.set_backlight(int(value))  # type: ignore[attr-defined]
            self._last_bl = int(value)
        except Exception:
            pass

    def present(self, s: dict):
        if not self.ok or not self.board:
            return

        st = (s.get("status") or "idle").lower()

        # Backlight sleep: if idle for N seconds, turn backlight off.
        # Wake on any non-idle active state.
        if SLEEP_SECS and SLEEP_SECS > 0:
            idle_too_long = (st == "idle") and ((time.time() - _last_update_at) >= SLEEP_SECS)
            if idle_too_long and not self._asleep:
                self._asleep = True
                self._set_backlight(0)
            elif (not idle_too_long) and self._asleep:
                self._asleep = False
                self._set_backlight(WAKE_BACKLIGHT)

        rgb = {
            "idle": (0, 0, 0),
            "listening": (0, 90, 40),
            "transcribing": (120, 90, 0),
            "thinking": (0, 60, 140),
            "speaking": (120, 0, 140),
            "reminder": (140, 60, 0),
            "error": (140, 0, 0),
        }.get(st, (20, 20, 20))

        try:
            # RGB indicator gives quick feedback even when the screen is busy
            self.board.set_rgb(*rgb)  # type: ignore[attr-defined]
        except Exception:
            pass

        try:
            frame = render_frame(s, time.time())
            px = rgb888_to_rgb565_bytes(frame)
            # PiSugar examples pass a Python list of bytes
            self.board.draw_image(0, 0, W, H, list(px))
        except Exception as e:
            sys.stdout.write(f"[display] draw failed: {e}\n")
            sys.stdout.flush()


def pick_backend() -> DisplayBackend:
    if MODE == "off":
        return StdoutBackend()
    if MODE == "stdout":
        return StdoutBackend()
    if MODE == "whisplay":
        b = WhisplayBackend()
        return b if b.ok else StdoutBackend()

    # auto
    b = WhisplayBackend()
    return b if b.ok else StdoutBackend()


backend: DisplayBackend = pick_backend()


def render_loop():
    global _state_dirty, _last_frame_at, _last_render_status

    while not _stop:
        with _state_lock:
            s = dict(state)
            dirty = _state_dirty
            _state_dirty = False

        st = (s.get("status") or "idle").lower()
        active = is_active_status(st)
        fps = ACTIVE_FPS if active else IDLE_FPS
        interval = 1.0 / max(0.2, fps)

        now = time.time()
        due = (now - _last_frame_at) >= interval

        # Render when: dirty update came in OR it's time for next animation frame
        if dirty or due or (_last_render_status != st):
            try:
                backend.present(s)
            except Exception as e:
                sys.stdout.write(f"[display] present error: {e}\n")
                sys.stdout.flush()
            _last_frame_at = now
            _last_render_status = st

        time.sleep(0.02)



class Handler(BaseHTTPRequestHandler):
    def _json(self, code: int, obj: dict):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if self.path == "/health":
            self._json(200, {"ok": True})
            return
        if self.path == "/state":
            self._json(200, {"ok": True, "state": state})
            return
        self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):  # noqa: N802
        if self.path != "/update":
            self._json(404, {"ok": False, "error": "not found"})
            return

        n = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(n).decode("utf-8").strip() if n else "{}"
        try:
            body = json.loads(raw) if raw else {}
        except Exception:
            self._json(400, {"ok": False, "error": "invalid json"})
            return

        global _state_dirty
        global _last_update_at

        # Do not let background-only updates (e.g., wifi polling) prevent idle sleep.
        # We treat an update as "activity" only if it changes status or visible text lines.
        activity_keys = {"status", "line1", "line2", "line3", "line4", "next"}
        is_activity = any(k in activity_keys for k in (body or {}).keys())

        with _state_lock:
            # Shallow merge
            for k, v in (body or {}).items():
                if k in state:
                    state[k] = v
            state["updatedAt"] = now_iso()
            _state_dirty = True
            if is_activity:
                _last_update_at = time.time()

        self._json(200, {"ok": True})


def main():
    # Kick off renderer loop first (so it can animate even with no updates)
    t = threading.Thread(target=render_loop, daemon=True)
    t.start()

    httpd = HTTPServer((HOST, PORT), Handler)
    sys.stdout.write(f"[display] listening on http://{HOST}:{PORT} (mode={MODE})\n")
    sys.stdout.flush()
    httpd.serve_forever()


if __name__ == "__main__":
    main()
