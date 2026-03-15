#!/usr/bin/env bash
set -euo pipefail

# Wi‑Fi power control for battery savings.
#
# Usage:
#   sudo ./scripts/wifi_power.sh on
#   sudo ./scripts/wifi_power.sh off
#   sudo ./scripts/wifi_power.sh status
#
# Requires: rfkill + NetworkManager (nmcli).

IFACE=${POCKETAGENT_WIFI_IFACE:-wlan0}

cmd=${1:-status}

wifi_on() {
  rfkill unblock wifi >/dev/null 2>&1 || true
  # Give NetworkManager a chance to bring up the connection.
  nmcli dev connect "$IFACE" >/dev/null 2>&1 || true
}

wifi_off() {
  # Disconnect first (cleaner)
  nmcli dev disconnect "$IFACE" >/dev/null 2>&1 || true
  rfkill block wifi >/dev/null 2>&1 || true
}

wifi_status() {
  # Print a small status line
  nmcli -t -f DEVICE,STATE,CONNECTION dev status 2>/dev/null | grep -E "^${IFACE}:" || true
  rfkill list wifi 2>/dev/null || true
}

case "$cmd" in
  on) wifi_on;;
  off) wifi_off;;
  status) wifi_status;;
  *)
    echo "Usage: $0 {on|off|status}" >&2
    exit 2
    ;;
esac
