#!/usr/bin/env bash
set -euo pipefail

# Install always-on Wi-Fi setup fallback AP + captive portal.
# - Creates a "PocketAgent-Setup" AP (hostapd)
# - Runs dnsmasq for DHCP/DNS
# - Runs PocketAgent wifi portal on 192.168.4.1:80
# - Only starts AP when wlan0 is NOT connected (fallback)

need_root() {
  if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
    echo "Please run as root (sudo)." >&2
    exit 1
  fi
}

main() {
  need_root

  echo "[wifi-ap] Installing packages..."
  apt-get update
  apt-get install -y hostapd dnsmasq

  echo "[wifi-ap] Installing systemd unit + helper script..."
  install -m 0755 -D /opt/pocketagent/scripts/wifi_ap_fallback.sh /usr/local/bin/pocketagent-wifi-ap-fallback
  install -m 0644 -D /opt/pocketagent/systemd/pocketagent-wifi-ap-fallback.service /etc/systemd/system/pocketagent-wifi-ap-fallback.service
  install -m 0644 -D /opt/pocketagent/systemd/pocketagent-ap-iface.service /etc/systemd/system/pocketagent-ap-iface.service

  systemctl daemon-reload

  # Create the AP interface early at boot (needed for concurrent AP+client mode)
  systemctl enable --now pocketagent-ap-iface || true

  systemctl enable --now pocketagent-wifi-ap-fallback

  echo "[wifi-ap] Done. When disconnected, connect your phone to SSID: PocketAgent-Setup"
  echo "          Then open: http://192.168.4.1/"
}

main "$@"
