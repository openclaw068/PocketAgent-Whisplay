#!/usr/bin/env bash
set -euo pipefail

# PocketAgent Wi‑Fi recovery helper.
# Goal: provide a "hard escape hatch" when the captive portal UI is broken.
# Intended usage: SSH into the device (including over the setup AP at 192.168.4.1)
# and run:
#   sudo /opt/pocketagent/scripts/wifi_recover.sh
#
# Behavior:
# - Stops the setup AP fallback service (if running)
# - Re-enables NetworkManager control of wlan0
# - Ensures the rescue connection autoconnect is ON
# - Brings up the rescue connection on wlan0

IFACE=${POCKETAGENT_WIFI_IFACE:-wlan0}
RESCUE_CONN=${POCKETAGENT_WIFI_RESCUE_CONN:-IoT}

need_root() {
  if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
    echo "Please run as root (sudo)." >&2
    exit 1
  fi
}

main() {
  need_root

  echo "[wifi-recover] iface=$IFACE rescue=$RESCUE_CONN"

  # Stop AP fallback if installed
  systemctl stop pocketagent-wifi-ap-fallback >/dev/null 2>&1 || true

  # Let NM manage the interface again
  nmcli dev set "$IFACE" managed yes >/dev/null 2>&1 || true

  # Ensure autoconnect for rescue connection
  nmcli connection modify "$RESCUE_CONN" connection.autoconnect yes >/dev/null 2>&1 || true

  echo "[wifi-recover] bringing up: $RESCUE_CONN"
  nmcli connection up "$RESCUE_CONN" ifname "$IFACE" || true

  echo "[wifi-recover] status:"
  nmcli -t -f GENERAL.STATE,GENERAL.CONNECTION dev show "$IFACE" || true

  # Restart fallback service so it will come back if we fail to connect
  systemctl start pocketagent-wifi-ap-fallback >/dev/null 2>&1 || true
}

main "$@"
