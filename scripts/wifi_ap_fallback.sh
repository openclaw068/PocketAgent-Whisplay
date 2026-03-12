#!/usr/bin/env bash
set -euo pipefail

# Start/stop a fallback setup AP when not connected.
# Intended to be run as a long-lived service.
#
# Design goals:
# - Works headless (no GUI / no secret-agent prompts)
# - Produces actionable logs when AP fails to start

# Uplink (internet) interface. Usually wlan0.
UPLINK_IFACE=${POCKETAGENT_UPLINK_IFACE:-wlan0}

# AP interface for the setup portal.
# Recommended: a virtual AP interface (ap0) created on top of wlan0.
AP_IFACE=${POCKETAGENT_AP_IFACE:-ap0}

# Back-compat: if POCKETAGENT_WIFI_IFACE is set, treat it as the AP iface.
AP_IFACE=${POCKETAGENT_WIFI_IFACE:-$AP_IFACE}

# If true, always run the setup AP (even if uplink is connected).
# Defaults to true when AP_IFACE != UPLINK_IFACE (concurrent mode).
SETUP_AP_ALWAYS_ON=${POCKETAGENT_SETUP_AP_ALWAYS_ON:-}

AP_SSID=${POCKETAGENT_SETUP_AP_SSID:-PocketAgent-Setup}
AP_PASS=${POCKETAGENT_SETUP_AP_PASS:-pocketagent}
AP_ADDR=${POCKETAGENT_SETUP_AP_ADDR:-192.168.4.1}
AP_MASK=${POCKETAGENT_SETUP_AP_MASK:-24}
AP_CHANNEL=${POCKETAGENT_SETUP_AP_CHANNEL:-1}
AP_COUNTRY=${POCKETAGENT_SETUP_AP_COUNTRY:-US}
PORT=${POCKETAGENT_WIFI_PORTAL_PORT:-3792}

HOSTAPD_CONF=/run/pocketagent-hostapd.conf
DNSMASQ_CONF=/run/pocketagent-dnsmasq.conf

LOG_DIR=${POCKETAGENT_LOG_DIR:-/opt/pocketagent/data}
LOG_FILE=${POCKETAGENT_WIFI_AP_LOG_FILE:-$LOG_DIR/wifi_ap_fallback.log}

mkdir -p "$LOG_DIR" >/dev/null 2>&1 || true

ts() { date -Is; }
log() { echo "[$(ts)] $*" | tee -a "$LOG_FILE" >&2; }

have_cmd() { command -v "$1" >/dev/null 2>&1; }

uplink_connected() {
  # Prefer a stable definition: NM says the device is connected (100).
  nmcli -t -f GENERAL.STATE dev show "$UPLINK_IFACE" 2>/dev/null | grep -qE ':100\b'
}

ap_iface_exists() {
  iw dev 2>/dev/null | grep -qE "Interface\s+$AP_IFACE\b"
}

ap_iface_type() {
  # outputs: AP|managed|... (best effort)
  iw dev 2>/dev/null | awk -v iface="$AP_IFACE" '
    $1=="Interface" && $2==iface {in=1; next}
    in && $1=="type" {print $2; exit}
  '
}

delete_ap_iface() {
  if ap_iface_exists; then
    log "[wifi-ap] deleting existing interface $AP_IFACE"
    iw dev "$AP_IFACE" del 2>>"$LOG_FILE" || true
  fi
}

create_ap_iface() {
  if ap_iface_exists; then
    local t
    t="$(ap_iface_type || true)"
    if [[ "$t" == "AP" ]]; then
      return 0
    fi

    log "[wifi-ap] $AP_IFACE exists but type=$t (expected AP); recreating"
    delete_ap_iface
  fi

  log "[wifi-ap] creating AP interface $AP_IFACE on $UPLINK_IFACE"
  if ! iw dev "$UPLINK_IFACE" interface add "$AP_IFACE" type __ap 2>>"$LOG_FILE"; then
    log "[wifi-ap] ERROR: failed to create $AP_IFACE (driver may not support concurrent AP+client)"
    return 1
  fi
  ip link set "$AP_IFACE" up || true
}

start_ap() {
  # Decide default for always-on behavior.
  if [[ -z "${SETUP_AP_ALWAYS_ON}" ]]; then
    if [[ "$AP_IFACE" != "$UPLINK_IFACE" ]]; then
      SETUP_AP_ALWAYS_ON=true
    else
      SETUP_AP_ALWAYS_ON=false
    fi
  fi

  log "[wifi-ap] starting setup AP on $AP_IFACE (uplink=$UPLINK_IFACE always_on=$SETUP_AP_ALWAYS_ON)"

  create_ap_iface || return 1

  if ! have_cmd hostapd; then
    log "[wifi-ap] ERROR: hostapd not found (install: sudo apt-get install -y hostapd)"
    return 1
  fi
  if ! have_cmd dnsmasq; then
    log "[wifi-ap] ERROR: dnsmasq not found (install: sudo apt-get install -y dnsmasq)"
    return 1
  fi

  # Ensure Wi-Fi isn't soft-blocked
  rfkill unblock wifi >/dev/null 2>&1 || true

  # Stop NM from managing the AP iface while we AP
  nmcli dev disconnect "$AP_IFACE" >/dev/null 2>&1 || true

  ip link set "$AP_IFACE" down || true
  ip addr flush dev "$AP_IFACE" || true
  ip addr add "$AP_ADDR/$AP_MASK" dev "$AP_IFACE" || true
  ip link set "$AP_IFACE" up || true

  cat > "$HOSTAPD_CONF" <<EOF
country_code=$AP_COUNTRY
interface=$AP_IFACE
driver=nl80211
ssid=$AP_SSID
hw_mode=g
channel=$AP_CHANNEL
ieee80211n=1
wmm_enabled=1
auth_algs=1
wpa=2
wpa_passphrase=$AP_PASS
wpa_key_mgmt=WPA-PSK
rsn_pairwise=CCMP
EOF

  cat > "$DNSMASQ_CONF" <<EOF
interface=$AP_IFACE
bind-interfaces
dhcp-range=192.168.4.10,192.168.4.200,12h
address=/#/$AP_ADDR
EOF

  # Start services (foreground handled by systemd)
  dnsmasq -C "$DNSMASQ_CONF" -k >>"$LOG_FILE" 2>&1 &
  DNSMASQ_PID=$!

  hostapd "$HOSTAPD_CONF" -dd >>"$LOG_FILE" 2>&1 &
  HOSTAPD_PID=$!

  # Start portal on port 80 bound to AP addr
  POCKETAGENT_WIFI_PORTAL_HOST="$AP_ADDR" POCKETAGENT_WIFI_PORTAL_PORT=80 \
    python3 /opt/pocketagent/wifi_portal/server.py >>"$LOG_FILE" 2>&1 &
  PORTAL_PID=$!

  log "[wifi-ap] setup AP active: ssid=$AP_SSID channel=$AP_CHANNEL addr=$AP_ADDR"
  log "[wifi-ap] pids: dnsmasq=$DNSMASQ_PID hostapd=$HOSTAPD_PID portal=$PORTAL_PID"

  echo $DNSMASQ_PID > /run/pocketagent-dnsmasq.pid
  echo $HOSTAPD_PID > /run/pocketagent-hostapd.pid
  echo $PORTAL_PID > /run/pocketagent-portal.pid
}

stop_ap() {
  log "[wifi-ap] stopping setup AP"
  for f in /run/pocketagent-portal.pid /run/pocketagent-hostapd.pid /run/pocketagent-dnsmasq.pid; do
    if [[ -f "$f" ]]; then
      kill "$(cat "$f")" >/dev/null 2>&1 || true
      rm -f "$f"
    fi
  done

  ip addr flush dev "$AP_IFACE" || true

  # Let NetworkManager manage it again
  nmcli dev connect "$AP_IFACE" >/dev/null 2>&1 || true
}

cleanup() {
  stop_ap || true
}
trap cleanup EXIT

log "[wifi-ap] service started (uplink=$UPLINK_IFACE ap_iface=$AP_IFACE ssid=$AP_SSID addr=$AP_ADDR)"

AP_RUNNING=0

while true; do
  if [[ "${SETUP_AP_ALWAYS_ON:-}" == "true" ]]; then
    # Always-on mode: keep the setup AP up even if uplink is connected.
    if [[ $AP_RUNNING -eq 0 ]]; then
      if start_ap; then
        AP_RUNNING=1
      else
        log "[wifi-ap] ERROR: start_ap failed; retrying in 5s"
      fi
    fi
  else
    # Fallback mode: only start AP when uplink is NOT connected.
    if uplink_connected; then
      if [[ $AP_RUNNING -eq 1 ]]; then
        stop_ap
        AP_RUNNING=0
      fi
    else
      if [[ $AP_RUNNING -eq 0 ]]; then
        if start_ap; then
          AP_RUNNING=1
        else
          log "[wifi-ap] ERROR: start_ap failed; retrying in 5s"
        fi
      fi
    fi
  fi

  sleep 5
done
