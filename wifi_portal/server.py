#!/usr/bin/env python3
"""PocketAgent Wi-Fi setup portal (offline-friendly).

Goals:
- Works with no internet.
- Lets user enter SSID + password from a phone.
- Adds the network as a saved NetworkManager connection (does NOT force switching unless user clicks connect).

Assumptions:
- Raspberry Pi OS Bookworm with NetworkManager.
- nmcli is available.

Security note:
- This is intended for local LAN use.
- It accepts a Wi-Fi password; keep it bound to localhost or your setup AP interface.
"""

from __future__ import annotations

import json
import os
import subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer

HOST = os.environ.get("POCKETAGENT_WIFI_PORTAL_HOST", "0.0.0.0")
PORT = int(os.environ.get("POCKETAGENT_WIFI_PORTAL_PORT", "3792"))

IFACE = os.environ.get("POCKETAGENT_WIFI_IFACE", "wlan0")

HTML = """<!doctype html>
<html>
<head>
  <meta charset=\"utf-8\" />
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
  <title>PocketAgent Wi‑Fi Setup</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:24px;max-width:760px}
    h1{font-size:22px;margin:0 0 12px}
    .card{border:1px solid #ddd;border-radius:12px;padding:16px;margin-bottom:14px}
    label{display:block;font-size:14px;margin:10px 0 6px}
    input{width:100%;font-size:16px;padding:10px;border:1px solid #ccc;border-radius:10px}
    button{margin-top:14px;padding:10px 14px;border-radius:10px;border:0;background:#111;color:#fff;font-size:16px;cursor:pointer}
    button.secondary{background:#444}
    .row{display:flex;gap:10px}
    .row > *{flex:1}
    .muted{color:#666;font-size:13px;margin-top:10px;line-height:1.35}
    pre{background:#f6f6f6;padding:10px;border-radius:10px;overflow:auto}
    table{width:100%;border-collapse:collapse}
    th,td{padding:10px;border-bottom:1px solid #eee;font-size:14px;text-align:left}
    .pill{display:inline-block;padding:3px 8px;border-radius:999px;background:#f0f0f0;font-size:12px}
  </style>
</head>
<body>
  <h1>PocketAgent Wi‑Fi Setup</h1>

  <div class=\"card\">
    <div class=\"row\">
      <div>
        <label>SSID</label>
        <input id=\"ssid\" placeholder=\"Network name\" />
      </div>
      <div>
        <label>Priority</label>
        <input id=\"prio\" placeholder=\"e.g. 50\" value=\"50\" />
      </div>
    </div>
    <label>Password</label>
    <input id=\"pass\" type=\"password\" placeholder=\"Wi‑Fi password\" />

    <button onclick=\"save()\">Save network</button>
    <div class=\"muted\">Saves the network to NetworkManager. You can optionally connect immediately from the list below.</div>

    <div id=\"out\" style=\"margin-top:12px\"></div>
  </div>

  <div class=\"card\">
    <div style=\"display:flex;align-items:center;justify-content:space-between;gap:10px\">
      <strong>Saved Wi‑Fi networks</strong>
      <button class=\"secondary\" onclick=\"refresh()\" style=\"margin-top:0\">Refresh</button>
    </div>
    <div class=\"muted\">Tap “Connect now” to switch networks. If you’re using the setup AP fallback, your phone may disconnect when the Pi switches.</div>
    <div id=\"list\" style=\"margin-top:10px\">Loading…</div>
  </div>

  <script>
    async function refresh(){
      const list = document.getElementById('list');
      list.textContent = 'Loading…';
      const res = await fetch('/api/list');
      const j = await res.json().catch(()=>({ok:false,error:'bad json'}));
      if (!j.ok){
        list.innerHTML = '<pre>'+JSON.stringify(j,null,2)+'</pre>';
        return;
      }
      const rows = j.networks || [];
      if (!rows.length){
        list.textContent = 'No saved Wi‑Fi networks found.';
        return;
      }
      // Build DOM to avoid fragile inline onclick quoting issues.
      const table = document.createElement('table');
      table.innerHTML = '<thead><tr><th>Name</th><th>Priority</th><th>Status</th><th></th></tr></thead><tbody></tbody>';
      const tbody = table.querySelector('tbody');

      for (const n of rows){
        const tr = document.createElement('tr');

        const tdName = document.createElement('td');
        tdName.textContent = n.name || '';

        const tdPr = document.createElement('td');
        tdPr.textContent = (n.priority==null?'':String(n.priority));

        const tdSt = document.createElement('td');
        if (n.active){
          const sp = document.createElement('span');
          sp.className = 'pill';
          sp.textContent = 'active';
          tdSt.appendChild(sp);
        }

        const tdBtn = document.createElement('td');
        const btn = document.createElement('button');
        btn.style.marginTop = '0';
        btn.textContent = 'Connect now';
        btn.dataset.name = n.name || '';
        btn.addEventListener('click', async (ev) => {
          const name = ev.currentTarget.dataset.name;
          await connectNow(name);
        });
        tdBtn.appendChild(btn);

        tr.appendChild(tdName);
        tr.appendChild(tdPr);
        tr.appendChild(tdSt);
        tr.appendChild(tdBtn);
        tbody.appendChild(tr);
      }

      list.innerHTML = '';
      list.appendChild(table);
    }

    async function connectNow(name){
      const out = document.getElementById('out');
      out.innerHTML = 'Connecting…';
      const res = await fetch('/api/connect', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name})});
      const j = await res.json().catch(()=>({ok:false,error:'bad json'}));
      out.innerHTML = '<pre>'+JSON.stringify(j,null,2)+'</pre>';
      setTimeout(refresh, 1000);
    }

    async function save(){
      const ssid = document.getElementById('ssid').value.trim();
      const pass = document.getElementById('pass').value;
      const prio = Number(document.getElementById('prio').value || '50');
      const out = document.getElementById('out');
      out.innerHTML = 'Saving…';
      const res = await fetch('/api/save', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ssid, pass, priority: prio})});
      const j = await res.json().catch(()=>({ok:false,error:'bad json'}));
      out.innerHTML = '<pre>'+JSON.stringify(j,null,2)+'</pre>';
      setTimeout(refresh, 500);
    }

    refresh();
  </script>
</body>
</html>"""


def run(cmd: list[str]) -> tuple[int, str]:
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    return p.returncode, (p.stdout or "").strip()


def ensure_connection(ssid: str):
    # if connection profile exists, do nothing
    code, out = run(["nmcli", "-t", "-f", "NAME", "connection", "show"])
    if code != 0:
        raise RuntimeError(out)
    names = set(out.splitlines())
    if ssid in names:
        return

    code, out = run(["nmcli", "connection", "add", "type", "wifi", "ifname", IFACE, "con-name", ssid, "ssid", ssid])
    if code != 0:
        raise RuntimeError(out)


def save_connection(ssid: str, password: str, priority: int):
    """Save/update a Wi‑Fi connection profile.

    We apply priority/autoconnect first so even if security settings error,
    the profile still gets the requested priority.
    """
    ensure_connection(ssid)

    # 1) autoconnect + priority
    cmd1 = [
        "nmcli", "connection", "modify", ssid,
        "connection.autoconnect", "yes",
        "connection.autoconnect-priority", str(int(priority)),
    ]
    code, out = run(cmd1)
    if code != 0:
        raise RuntimeError(out)

    # 2) security + password
    cmd2 = [
        "nmcli", "connection", "modify", ssid,
        "wifi-sec.key-mgmt", "wpa-psk",
        "wifi-sec.psk", password,
    ]
    code, out = run(cmd2)
    if code != 0:
        raise RuntimeError(out)


def list_connections():
    # returns list of {name, priority, active}
    code, out = run(["nmcli", "-t", "-f", "NAME,TYPE,AUTOCONNECT,AUTOCONNECT-PRIORITY", "connection", "show"])
    if code != 0:
        raise RuntimeError(out)

    active_name = None
    # Active connection (best-effort)
    code2, out2 = run(["nmcli", "-t", "-f", "NAME,DEVICE", "connection", "show", "--active"])
    if code2 == 0:
        for ln in out2.splitlines():
            parts = ln.split(":")
            if len(parts) >= 2 and parts[1] == IFACE:
                active_name = parts[0]
                break

    nets = []
    for ln in out.splitlines():
        parts = ln.split(":")
        if len(parts) < 4:
            continue
        name, typ, _auto, prio = parts[0], parts[1], parts[2], parts[3]
        if typ != "802-11-wireless":
            continue
        try:
            p = int(prio) if prio else None
        except Exception:
            p = None
        nets.append({"name": name, "priority": p, "active": (name == active_name)})

    # Sort by priority desc, active first
    nets.sort(key=lambda x: ((0 if x["active"] else 1), -(x["priority"] or 0), x["name"]))
    return nets


def connect_now(name: str):
    # Brings up the connection on the target iface.
    code, out = run(["nmcli", "connection", "up", name, "ifname", IFACE])
    if code != 0:
        raise RuntimeError(out)


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: bytes, ct: str = "text/html; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        # Normalize path (strip query string)
        p = self.path.split("?", 1)[0]

        # Captive portal detection endpoints.
        # For provisioning (no internet), we want these checks to lead the OS to our portal.
        # Returning "Success" / 204 would *suppress* the captive portal UI.
        captive_paths = {
            # iOS/macOS
            "/hotspot-detect.html",
            # Android/ChromeOS
            "/generate_204",
            # Windows
            "/ncsi.txt",
            "/connecttest.txt",
            # Common Apple legacy path some devices hit
            "/library/test/success.html",
        }
        if p in captive_paths:
            self.send_response(302)
            self.send_header("Location", "/")
            self.end_headers()
            return

        if p == "/" or self.path.startswith("/?"):
            return self._send(200, HTML.encode("utf-8"))
        if p == "/health":
            return self._send(200, b"{\"ok\":true}", "application/json")
        if p == "/api/list":
            try:
                nets = list_connections()
                return self._send(200, json.dumps({"ok": True, "networks": nets}).encode("utf-8"), "application/json")
            except Exception as e:
                return self._send(500, json.dumps({"ok": False, "error": str(e)}).encode("utf-8"), "application/json")

        # Robust iPhone-friendly fallback: redirect any unknown path to portal root.
        # Many clients attempt to open random URLs immediately after joining.
        self.send_response(302)
        self.send_header("Location", "/")
        self.end_headers()
        return

    def do_POST(self):
        n = int(self.headers.get("content-length") or "0")
        raw = self.rfile.read(n) if n else b"{}"
        try:
            body = json.loads(raw.decode("utf-8"))
        except Exception:
            body = {}

        if self.path == "/api/save":
            ssid = str(body.get("ssid") or "").strip()
            password = str(body.get("pass") or "")
            priority = int(body.get("priority") or 50)

            if not ssid:
                return self._send(400, b"{\"ok\":false,\"error\":\"missing ssid\"}", "application/json")
            if not password:
                return self._send(400, b"{\"ok\":false,\"error\":\"missing password\"}", "application/json")

            try:
                save_connection(ssid, password, priority)
                return self._send(200, json.dumps({"ok": True, "saved": ssid, "priority": priority}).encode("utf-8"), "application/json")
            except Exception as e:
                return self._send(500, json.dumps({"ok": False, "error": str(e)}).encode("utf-8"), "application/json")

        if self.path == "/api/connect":
            name = str(body.get("name") or "").strip()
            if not name:
                return self._send(400, b"{\"ok\":false,\"error\":\"missing name\"}", "application/json")
            try:
                connect_now(name)
                return self._send(200, json.dumps({"ok": True, "connected": name}).encode("utf-8"), "application/json")
            except Exception as e:
                return self._send(500, json.dumps({"ok": False, "error": str(e)}).encode("utf-8"), "application/json")

        return self._send(404, b"{\"ok\":false,\"error\":\"not found\"}", "application/json")


def main():
    print(f"[wifi-portal] listening on http://{HOST}:{PORT} (iface={IFACE})")
    HTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
