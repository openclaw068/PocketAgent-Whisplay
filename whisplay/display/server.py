#!/usr/bin/env python3
"""Whisplay display sidecar for PocketAgent.

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
}

# Animation settings
W, H = 240, 280
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


def _wrap_text(draw: ImageDraw.ImageDraw, text: str, font, max_width: int, max_lines: int = 2):
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

    # If still too long, ellipsize last line
    if lines:
        last = lines[-1]
        while draw.textlength(last, font=font) > max_width and len(last) > 1:
            last = last[:-2].rstrip() + "…"
        lines[-1] = last
    return lines


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
    """Render a single 240x280 frame as a PIL RGB image.

    Returns a PIL Image, or raises if PIL isn't available.
    """
    if Image is None or ImageDraw is None:
        raise RuntimeError("PIL not installed (install python3-pil)")

    status = (s.get("status") or "idle").lower()

    img = Image.new("RGB", (W, H), (0, 0, 0))
    d = ImageDraw.Draw(img)

    # background gradient
    c1, c2, c3 = _bg_color_for(status)
    for y in range(H):
        # three-stop lerp: top->mid and mid->bottom
        if y < H * 0.6:
            a = y / (H * 0.6)
            r = int(c1[0] + (c2[0] - c1[0]) * a)
            g = int(c1[1] + (c2[1] - c1[1]) * a)
            b = int(c1[2] + (c2[2] - c1[2]) * a)
        else:
            a = (y - H * 0.6) / (H * 0.4)
            r = int(c2[0] + (c3[0] - c2[0]) * a)
            g = int(c2[1] + (c3[1] - c2[1]) * a)
            b = int(c2[2] + (c3[2] - c2[2]) * a)
        d.line([(0, y), (W, y)], fill=(r, g, b))

    # status pill
    label = (status or "idle").upper()
    pill = (60, 14, 180, 38)
    d.rounded_rectangle(pill, radius=12, fill=(255, 255, 255), outline=(220, 230, 255), width=2)
    if _FONT_STATUS is not None:
        tw = d.textlength(label, font=_FONT_STATUS)
        d.text(((W - tw) // 2, 18), label, font=_FONT_STATUS, fill=(60, 80, 120))

    # robot head bob
    bob = 2.0 * (0.5 - abs(((t / 2.6) % 1.0) - 0.5))  # triangle wave 0..1
    bob_y = int(bob * 2) - 1

    head = (30, 55 + bob_y, 210, 225 + bob_y)
    d.rounded_rectangle(head, radius=44, fill=(248, 250, 255), outline=(210, 220, 245), width=4)
    inner = (38, 63 + bob_y, 202, 217 + bob_y)
    d.rounded_rectangle(inner, radius=38, outline=(255, 255, 255), width=2)

    # antenna
    ax = W // 2
    stem = (ax - 4, 45 + bob_y, ax + 4, 65 + bob_y)
    d.rounded_rectangle(stem, radius=4, fill=(210, 220, 245))
    bulb = (ax - 14, 28 + bob_y, ax + 14, 56 + bob_y)
    d.ellipse(bulb, fill=(255, 120, 180), outline=(255, 255, 255), width=2)
    shine = (ax - 8, 32 + bob_y, ax - 2, 44 + bob_y)
    d.ellipse(shine, fill=(255, 200, 225))

    # Eyes: animate per status
    blink_phase = (t % 6.0)
    blinking = 5.6 < blink_phase < 5.9 and status == "idle"

    eye1 = [70, 95 + bob_y, 120, 145 + bob_y]
    eye2 = [120, 95 + bob_y, 170, 145 + bob_y]

    if status == "listening":
        # widen
        eye1[1] -= 3
        eye1[3] += 3
        eye2[1] -= 3
        eye2[3] += 3
    elif status == "thinking":
        # slight horizontal drift
        drift = int(((t * 2) % 2 - 1) * 3)
        eye1[0] += drift
        eye1[2] += drift
        eye2[0] += drift
        eye2[2] += drift

    def draw_eye(e):
        x0, y0, x1, y1 = e
        if blinking:
            d.rounded_rectangle((x0, (y0 + y1) // 2 - 3, x1, (y0 + y1) // 2 + 3), radius=6, fill=(30, 40, 60))
            return
        d.rounded_rectangle((x0, y0, x1, y1), radius=18, fill=(30, 40, 60))
        d.ellipse((x0 + 10, y0 + 10, x0 + 22, y0 + 22), fill=(255, 255, 255))
        d.ellipse((x0 + 22, y0 + 22, x0 + 28, y0 + 28), fill=(200, 230, 255))

    draw_eye(eye1)
    draw_eye(eye2)

    # cheeks
    for cx in (62, 178):
        d.ellipse((cx - 10, 152 + bob_y, cx + 10, 172 + bob_y), fill=(255, 205, 220))

    # mouth shapes
    mouth = (92, 160 + bob_y, 148, 178 + bob_y)
    d.rounded_rectangle(mouth, radius=12, fill=(235, 240, 255), outline=(210, 220, 245), width=2)

    if status == "speaking":
        phase = int((t * 8) % 4)
        if phase == 0:
            d.arc((96, 160 + bob_y, 144, 184 + bob_y), start=200, end=340, fill=(120, 140, 180), width=3)
        elif phase == 1:
            d.rounded_rectangle((102, 167 + bob_y, 138, 171 + bob_y), radius=3, fill=(120, 140, 180))
        elif phase == 2:
            d.ellipse((110, 164 + bob_y, 130, 176 + bob_y), outline=(120, 140, 180), width=3)
        else:
            d.arc((96, 162 + bob_y, 144, 186 + bob_y), start=210, end=330, fill=(120, 140, 180), width=3)
    elif status == "reminder":
        # surprised mouth
        d.ellipse((114, 164 + bob_y, 126, 176 + bob_y), outline=(120, 140, 180), width=3)
    else:
        d.arc((96, 162 + bob_y, 144, 186 + bob_y), start=200, end=340, fill=(120, 140, 180), width=3)

    # subtitle bubble
    subtitle = (s.get("line2") or s.get("next") or "").strip()
    if subtitle:
        subtitle = subtitle[:SUBTITLE_MAX_CHARS]
    else:
        subtitle = "ready" if status == "idle" else ""

    sub = (20, 235, 220, 270)
    d.rounded_rectangle(sub, radius=16, fill=(255, 255, 255), outline=(220, 230, 255), width=2)

    if _FONT_SUB is not None:
        lines = _wrap_text(d, subtitle, _FONT_SUB, max_width=190, max_lines=2)
        y = 242
        for ln in lines:
            d.text((30, y), ln, font=_FONT_SUB, fill=(60, 80, 120))
            y += 16

    return img


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
        self._init_driver()

    def _init_driver(self):
        try:
            # Prefer local vendored driver if present
            sys.path.insert(0, os.environ.get("WHISPLAY_DRIVER_PATH", "/opt/Whisplay/Driver"))
            from WhisPlay import WhisPlayBoard  # type: ignore

            self.board = WhisPlayBoard()
            try:
                # reasonable default backlight
                self.board.set_backlight(int(os.environ.get("POCKETAGENT_DISPLAY_BACKLIGHT", "60")))
            except Exception:
                pass
            self.ok = True
        except Exception as e:
            sys.stdout.write(f"[display] Whisplay backend unavailable: {e}\n")
            sys.stdout.flush()
            self.ok = False

    def present(self, s: dict):
        if not self.ok or not self.board:
            return

        st = (s.get("status") or "idle").lower()
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

        with _state_lock:
            # Shallow merge
            for k, v in (body or {}).items():
                if k in state:
                    state[k] = v
            state["updatedAt"] = now_iso()
            _state_dirty = True

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
