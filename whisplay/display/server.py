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
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

HOST = os.environ.get("POCKETAGENT_DISPLAY_HOST", "127.0.0.1")
PORT = int(os.environ.get("POCKETAGENT_DISPLAY_PORT", "3782"))

MODE = os.environ.get("POCKETAGENT_DISPLAY_MODE", "auto")  # auto|whisplay|stdout|off

state = {
    "updatedAt": None,
    "status": "idle",  # idle|listening|transcribing|thinking|speaking|error
    "line1": "PocketAgent",
    "line2": "",
    "line3": "",
    "line4": "",
    "next": "",
}


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class DisplayBackend:
    def present(self, s: dict):
        raise NotImplementedError


class StdoutBackend(DisplayBackend):
    def present(self, s: dict):
        # basic "poor man's" UI for dev/CI
        sys.stdout.write("\n[display] " + json.dumps(s, ensure_ascii=False) + "\n")
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
            self.ok = True
        except Exception as e:
            sys.stdout.write(f"[display] Whisplay backend unavailable: {e}\n")
            sys.stdout.flush()
            self.ok = False

    def present(self, s: dict):
        if not self.ok or not self.board:
            return

        # Render text -> image: for v1 we keep it simple.
        # TODO: implement PIL text rendering + board.show_image() / draw methods.
        # For now, use RGB LED as a status indicator + clear screen.
        st = (s.get("status") or "idle").lower()
        rgb = {
            "idle": (0, 0, 0),
            "listening": (0, 40, 0),
            "transcribing": (40, 40, 0),
            "thinking": (0, 0, 40),
            "speaking": (40, 0, 40),
            "error": (40, 0, 0),
        }.get(st, (10, 10, 10))

        try:
            # board expects 0-100-ish PWM values in many examples
            self.board.set_rgb(*rgb)  # type: ignore[attr-defined]
            self.board.fill_screen(0)  # black
        except Exception:
            pass


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

        # Shallow merge
        for k, v in (body or {}).items():
            if k in state:
                state[k] = v

        state["updatedAt"] = now_iso()

        try:
            backend.present(state)
        except Exception as e:
            sys.stdout.write(f"[display] present error: {e}\n")
            sys.stdout.flush()

        self._json(200, {"ok": True})


def main():
    httpd = HTTPServer((HOST, PORT), Handler)
    sys.stdout.write(f"[display] listening on http://{HOST}:{PORT} (mode={MODE})\n")
    sys.stdout.flush()
    httpd.serve_forever()


if __name__ == "__main__":
    main()
