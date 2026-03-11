#!/usr/bin/env bash
set -euo pipefail

# Start/stop a fallback setup AP when not connected.
# Intended to be run as a long-lived service.

IFACE=${POCKETAGENT_WIFI_IFACE:-wlan0}
AP_SSID=${POCKETAGENT_SETUP_AP_SSID:-PocketAgent-Setup}
AP_PASS=${POCKETAGENT_SETUP_AP_PASS:-pocketagent}
AP_ADDR=${POCKETAGENT_SETUP_AP_ADDR:-192.168.4.1}
AP_MASK=${POCKETAGENT_SETUP_AP_MASK:-24}
PORT=${POCKETAGENT_WIFI_PORTAL_PORT:-3792}

HOSTAPD_CONF=/run/pocketagent-hostapd.conf
DNSMASQ_CONF=/run/pocketagent-dnsmasq.conf

connected() {
  nmcli -t -f GENERAL.STATE dev show "$IFACE" 2>/dev/null | grep -qE ':100\b'
}

start_ap() {
  echo "[wifi-ap] starting setup AP on $IFACE"

  # Stop NM from managing the iface while we AP
  nmcli dev disconnect "$IFACE" >/dev/null 2>&1 || true

  ip link set "$IFACE" down || true
  ip addr flush dev "$IFACE" || true
  ip addr add "$AP_ADDR/$AP_MASK" dev "$IFACE" || true
  ip link set "$IFACE" up || true

  cat > "$HOSTAPD_CONF" <<EOF
interface=$IFACE
driver=nl80211
ssid=$AP_SSID
hw_mode=g
channel=6
wmm_enabled=0
auth_algs=1
wpa=2
wpa_passphrase=$AP_PASS
wpa_key_mgmt=WPA-PSK
rsn_pairwise=CCMP
EOF

  cat > "$DNSMASQ_CONF" <<EOF
interface=$IFACE
bind-interfaces
dhcp-range=192.168.4.10,192.168.4.200,12h
address=/#/$AP_ADDR
EOF

  # Start services (foreground handled by systemd)
  dnsmasq -C "$DNSMASQ_CONF" -k &
  DNSMASQ_PID=$!

  hostapd "$HOSTAPD_CONF" -dd &
  HOSTAPD_PID=$!

  # Start portal on port 80 bound to AP addr
  POCKETAGENT_WIFI_PORTAL_HOST="$AP_ADDR" POCKETAGENT_WIFI_PORTAL_PORT=80 python3 /opt/pocketagent/wifi_portal/server.py &
  PORTAL_PID=$!

  echo $DNSMASQ_PID > /run/pocketagent-dnsmasq.pid
  echo $HOSTAPD_PID > /run/pocketagent-hostapd.pid
  echo $PORTAL_PID > /run/pocketagent-portal.pid
}

stop_ap() {
  echo "[wifi-ap] stopping setup AP"
  for f in /run/pocketagent-portal.pid /run/pocketagent-hostapd.pid /run/pocketagent-dnsmasq.pid; do
    if [[ -f "$f" ]]; then
      kill "$(cat "$f")" >/dev/null 2>&1 || true
      rm -f "$f"
    fi
  done

  ip addr flush dev "$IFACE" || true

  # Let NetworkManager manage it again
  nmcli dev connect "$IFACE" >/dev/null 2>&1 || true
}

cleanup() {
  stop_ap || true
}
trap cleanup EXIT

AP_RUNNING=0

while true; do
  if connected; then
    if [[ $AP_RUNNING -eq 1 ]]; then
      stop_ap
      AP_RUNNING=0
    fi
  else
    if [[ $AP_RUNNING -eq 0 ]]; then
      start_ap
      AP_RUNNING=1
    fi
  fi

  sleep 5
done
