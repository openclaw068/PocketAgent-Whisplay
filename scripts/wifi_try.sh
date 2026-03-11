#!/usr/bin/env bash
set -euo pipefail

# Safely try switching Wi‑Fi connections with an automatic rollback.
# This is designed to prevent "SSH lockout" when experimenting with hotspot/AP changes.
#
# Usage:
#   sudo ./scripts/wifi_try.sh --try "iPhone" --fallback "IoT" --timeout 25
#
# Behavior:
# - Attempts to bring up the TRY connection on the interface.
# - Waits up to TIMEOUT seconds for it to become the active connection.
# - If it doesn't become active, it forces the fallback connection back up.
# - Logs recent NetworkManager events to a log file.

IFACE=${POCKETAGENT_WIFI_IFACE:-wlan0}
TRY_CONN=""
FALLBACK_CONN="IoT"
TIMEOUT_SECS=25
LOG_FILE=${POCKETAGENT_WIFI_TRY_LOG:-/opt/pocketagent/data/wifi_try.log}

need_root() {
  if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
    echo "Please run as root (sudo)." >&2
    exit 1
  fi
}

usage() {
  echo "Usage: $0 --try <name> [--fallback <name>] [--timeout <secs>]" >&2
  exit 2
}

active_conn() {
  nmcli -t -f GENERAL.CONNECTION dev show "$IFACE" 2>/dev/null | sed 's/^GENERAL.CONNECTION://'
}

is_active() {
  [[ "$(active_conn)" == "$1" ]]
}

log_nm() {
  mkdir -p "$(dirname "$LOG_FILE")"
  {
    echo "---- $(date -Is) ----"
    echo "iface=$IFACE try=$TRY_CONN fallback=$FALLBACK_CONN timeout=$TIMEOUT_SECS"
    nmcli -t -f GENERAL.STATE,GENERAL.CONNECTION dev show "$IFACE" 2>/dev/null || true
    echo "-- NetworkManager (last 120s) --"
    journalctl -u NetworkManager --since "2 minutes ago" --no-pager | tail -n 200 || true
    echo
  } >> "$LOG_FILE" 2>&1 || true
}

main() {
  need_root

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --try) TRY_CONN="$2"; shift 2;;
      --fallback) FALLBACK_CONN="$2"; shift 2;;
      --timeout) TIMEOUT_SECS="$2"; shift 2;;
      *) usage;;
    esac
  done

  [[ -n "$TRY_CONN" ]] || usage

  echo "[wifi_try] trying: $TRY_CONN (fallback: $FALLBACK_CONN) on $IFACE"

  # Ensure fallback can autoconnect
  nmcli connection modify "$FALLBACK_CONN" connection.autoconnect yes >/dev/null 2>&1 || true

  log_nm

  # Attempt switch
  nmcli connection up "$TRY_CONN" ifname "$IFACE" >/dev/null 2>&1 || true

  # Wait for active
  for ((i=0;i<TIMEOUT_SECS;i++)); do
    if is_active "$TRY_CONN"; then
      echo "[wifi_try] active: $TRY_CONN"
      log_nm
      exit 0
    fi
    sleep 1
  done

  echo "[wifi_try] did not become active within ${TIMEOUT_SECS}s; rolling back to $FALLBACK_CONN" >&2
  nmcli connection up "$FALLBACK_CONN" ifname "$IFACE" >/dev/null 2>&1 || true
  log_nm
  exit 1
}

main "$@"
