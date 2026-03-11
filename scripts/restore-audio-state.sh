#!/usr/bin/env bash
set -euo pipefail

# Restore ALSA mixer state + PocketAgent audio env hints.
# Usage:
#   sudo ./scripts/restore-audio-state.sh ./config/audio
#
# Notes:
# - This restores /var/lib/alsa/asound.state then runs alsactl restore.
# - ALSA card indices can differ across devices. If the restored state doesn't take,
#   use the saved aplay/arecord/amixer dumps to adjust.

SRC_DIR=${1:-./config/audio}
STATE_FILE="$SRC_DIR/asound.state.current"

need_root() {
  if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
    echo "Please run as root (sudo)." >&2
    exit 1
  fi
}

need_root

if [[ ! -f "$STATE_FILE" ]]; then
  echo "ERROR: missing $STATE_FILE" >&2
  exit 1
fi

mkdir -p /var/lib/alsa
cp "$STATE_FILE" /var/lib/alsa/asound.state

# Restore immediately
alsactl restore || true

# Ensure alsa-restore service is enabled for reboot persistence
systemctl enable --now alsa-restore.service >/dev/null 2>&1 || true

echo "[restore-audio-state] restored /var/lib/alsa/asound.state"

echo "Next steps (if PocketAgent needs explicit device selection):"
echo "  - Review $SRC_DIR/pocketagent-audio-env.txt"
echo "  - Set POCKETAGENT_RECORDING_DEVICE / POCKETAGENT_PLAYBACK_DEVICE in /etc/default/pocketagent"
