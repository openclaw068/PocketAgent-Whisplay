#!/usr/bin/env bash
set -euo pipefail

# Install PocketAgent Wi-Fi portal systemd unit.
# Usage:
#   sudo ./scripts/install_wifi_portal.sh

need_root() {
  if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
    echo "Please run as root (sudo)." >&2
    exit 1
  fi
}

main() {
  need_root

  echo "[wifi-portal] Installing systemd unit..."
  install -m 0644 -D /opt/pocketagent/systemd/pocketagent-wifi-portal.service /etc/systemd/system/pocketagent-wifi-portal.service

  systemctl daemon-reload
  systemctl enable --now pocketagent-wifi-portal

  echo "[wifi-portal] Started. Check status:"
  systemctl status pocketagent-wifi-portal --no-pager | head -n 40 || true

  echo "[wifi-portal] Open http://<pi-ip>:3792 on your phone (same network)."
}

main "$@"
