#!/usr/bin/env bash
set -euo pipefail

# Install + enable Shairport Sync (AirPlay receiver) on Raspberry Pi OS Bookworm.
# This is intentionally simple and idempotent.

need_root() {
  if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
    echo "Please run as root (sudo)." >&2
    exit 1
  fi
}

main() {
  need_root

  echo "[airplay] Updating apt + installing shairport-sync..."
  apt-get update
  apt-get install -y shairport-sync

  echo "[airplay] Enabling + starting shairport-sync..."
  systemctl enable --now shairport-sync

  echo "[airplay] Status:"
  systemctl status shairport-sync --no-pager | head -n 40 || true

  echo "[airplay] Done. Config should be at /etc/shairport-sync.conf"
}

main "$@"
