#!/usr/bin/env bash
set -euo pipefail

# Backup ALSA state + basic audio device info to the repo (or a chosen folder).
# Usage:
#   sudo ./scripts/backup-audio-state.sh            # writes to ./config/audio
#   sudo ./scripts/backup-audio-state.sh /path/to/dir

OUT_DIR=${1:-./config/audio}
mkdir -p "$OUT_DIR"

TS=$(date -u +%Y%m%d-%H%M%S)

# 1) Save ALSA mixer state (requires root to read/write /var/lib/alsa)
if [[ -f /var/lib/alsa/asound.state ]]; then
  cp /var/lib/alsa/asound.state "$OUT_DIR/asound.state.current"
  cp /var/lib/alsa/asound.state "$OUT_DIR/asound.state.$TS"
else
  echo "WARN: /var/lib/alsa/asound.state not found" >&2
fi

# 2) Capture hardware + ALSA device enumeration
aplay -l > "$OUT_DIR/aplay-l.txt" 2>&1 || true
arecord -l > "$OUT_DIR/arecord-l.txt" 2>&1 || true
aplay -L > "$OUT_DIR/aplay-L.txt" 2>&1 || true

# 3) Capture mixer controls (helpful when card index changes)
for c in 0 1 2 3; do
  amixer -c "$c" scontrols > "$OUT_DIR/amixer-c${c}-scontrols.txt" 2>/dev/null || true
  amixer -c "$c" scontents > "$OUT_DIR/amixer-c${c}-scontents.txt" 2>/dev/null || true
done

# 4) Capture PocketAgent audio-related env (if present)
if [[ -f /etc/default/pocketagent ]]; then
  grep -E '^(POCKETAGENT_(RECORDING_DEVICE|PLAYBACK_DEVICE|RECORDING_CHANNELS|ALSA_CARD|ALSA_VOLUME_CONTROL)|OPENAI_BASE_URL)=' /etc/default/pocketagent \
    > "$OUT_DIR/pocketagent-audio-env.txt" 2>/dev/null || true
fi

echo "[backup-audio-state] wrote to: $OUT_DIR"
