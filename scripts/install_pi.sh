#!/usr/bin/env bash
set -euo pipefail

# PocketAgent installer for Raspberry Pi OS
# Usage: sudo bash scripts/install_pi.sh

APP_DIR="/opt/pocketagent"
# Prefer the user who invoked sudo (common on Pi OS Lite), otherwise fall back.
USER_NAME="${SUDO_USER:-pi}"
REPO_URL="${POCKETAGENT_REPO_URL:-https://github.com/openclaw068/PocketAgent-Whisplay.git}"
WHISPLAY_DRIVER_DIR="/opt/Whisplay"

# --- Secrets / required config ---
# Prefer OPENAI_API_KEY passed inline (non-interactive). Otherwise prompt.
OPENAI_KEY="${OPENAI_API_KEY:-}"
if [[ -z "$OPENAI_KEY" ]]; then
  read -rs -p "Enter OPENAI_API_KEY (input hidden): " OPENAI_KEY
  echo ""
fi
if [[ -z "$OPENAI_KEY" ]]; then
  echo "ERROR: OPENAI_API_KEY is required." >&2
  echo "Tip: OPENAI_API_KEY=\"sk-...\" sudo bash scripts/install_pi.sh" >&2
  exit 1
fi

apt-get update
apt-get install -y --no-install-recommends \
  git \
  ca-certificates \
  alsa-utils \
  sox \
  gpiod \
  libgpiod2 \
  python3 \
  python3-pil \
  python3-spidev

# Node.js: install Node 20+ via NodeSource if missing.
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Installing Node.js 20.x (NodeSource)…"
  apt-get install -y --no-install-recommends curl
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y --no-install-recommends nodejs
fi

# Quick sanity check
node -v

mkdir -p "$APP_DIR"

if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull
else
  echo "Cloning repo into $APP_DIR"
  git clone "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"

npm ci || npm install

mkdir -p "$APP_DIR/data"

# ---- Whisplay driver install (audio + LCD + button + RGB) ----
# We install this separately from PocketAgent so you can update either independently.
if [ -d "$WHISPLAY_DRIVER_DIR/.git" ]; then
  git -C "$WHISPLAY_DRIVER_DIR" pull --ff-only || true
else
  git clone --depth 1 https://github.com/PiSugar/Whisplay.git "$WHISPLAY_DRIVER_DIR"
fi

# Install/enable WM8960 + SPI/I2C/I2S overlays (script requires reboot afterwards)
if [ -f "$WHISPLAY_DRIVER_DIR/Driver/install_wm8960_drive.sh" ]; then
  bash "$WHISPLAY_DRIVER_DIR/Driver/install_wm8960_drive.sh" || true
fi

# Sanity checks: required CLI tools
for bin in node npm arecord aplay alsamixer gpiomon; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "Missing required tool: $bin"
    echo "Fix: sudo apt-get update && sudo apt-get install -y alsa-utils gpiod"
    exit 1
  fi
done

# Ensure service user can access audio + gpio
usermod -aG audio,gpio "$USER_NAME" || true

# Lock down env file location for secrets
# IMPORTANT: systemd EnvironmentFile expects ONE KEY=VALUE per line.
# If the file already exists, preserve it (do not clobber a working device config).
if [[ ! -f /etc/default/pocketagent ]]; then
  cat >/etc/default/pocketagent <<EOF
# PocketAgent environment (ONE KEY=VALUE per line)
#
# Required:
OPENAI_API_KEY="${OPENAI_KEY}"

# Mode:
# - chat = neutral voice agent (press-to-talk per turn)
# - reminders = reminder specialist
POCKETAGENT_MODE=chat

# Audio devices (card indices may vary across boots; update if needed)
POCKETAGENT_RECORDING_DEVICE=plughw:0,0
POCKETAGENT_PLAYBACK_DEVICE=plughw:0,0

# Volume control defaults (WM8960-friendly)
POCKETAGENT_ALSA_CARD=0
POCKETAGENT_ALSA_VOLUME_RAW_CONTROL=Playback
POCKETAGENT_ALSA_VOLUME_RAW_MIN=200
POCKETAGENT_ALSA_VOLUME_RAW_MAX=255

# Volume step for "volume up/down"
POCKETAGENT_VOLUME_STEP_PERCENT=5

# Whisplay HAT push-to-talk button (physical pin 11 = GPIO17)
# (some gpiod builds want chip number, not name)
POCKETAGENT_GPIO_CHIP=0
POCKETAGENT_PTT_GPIO_LINE=17
# Whisplay button is typically active-high (pressed = HIGH)
POCKETAGENT_PTT_ACTIVE_LOW=false

# Button stability (debounce/bounce)
POCKETAGENT_PTT_MIN_HOLD_MS=600
POCKETAGENT_PTT_DEBOUNCE_MS=80
POCKETAGENT_PTT_COOLDOWN_MS=200

# Optional: disable the "hold the button" spoken prompt
POCKETAGENT_PROMPT_ON_PRESS=false

# TTS speed (1.0 = normal). Try 1.2 for slightly faster speech.
POCKETAGENT_TTS_SPEED=1.2

# Chat mode memory carryover (persist last N messages between restarts)
POCKETAGENT_CHAT_CARRYOVER_COUNT=10

# Reminders daemon (local)
POCKETAGENT_REMINDERS_HOST=127.0.0.1
POCKETAGENT_REMINDERS_PORT=3791

# Chat agent local notify endpoint (reminders daemon POSTs here when due)
POCKETAGENT_NOTIFY_HOST=127.0.0.1
POCKETAGENT_NOTIFY_PORT=3781
# If you change host/port, also set:
# POCKETAGENT_NOTIFY_URL=http://127.0.0.1:3781/notify

# Display sidecar (Whisplay LCD)
POCKETAGENT_DISPLAY_HOST=127.0.0.1
POCKETAGENT_DISPLAY_PORT=3782
# Modes: auto|whisplay|stdout|off
POCKETAGENT_DISPLAY_MODE=auto

# Sleep after N seconds of idle inactivity (backlight only). 0 disables.
POCKETAGENT_DISPLAY_SLEEP_SECS=15

# Use vendored driver by default (prevents GPIO17 contention w/ PocketAgent)
WHISPLAY_DRIVER_PATH=/opt/pocketagent/whisplay/driver

# Optional hands-free chat (can be flaky on some ALSA stacks):
# POCKETAGENT_CHAT_AUTO_LISTEN=true
# POCKETAGENT_CHAT_AUTO_LISTEN_MAX_TURNS=5
# POCKETAGENT_AUTO_LISTEN_SECONDS=6
# POCKETAGENT_AUTO_LISTEN_DELAY_MS=2000
# POCKETAGENT_AUTO_LISTEN_RECORD_RETRIES=20
EOF
else
  echo "[install_pi] /etc/default/pocketagent exists; preserving it (not overwriting)."
fi

chown root:root /etc/default/pocketagent
chmod 600 /etc/default/pocketagent

chown -R "$USER_NAME":"$USER_NAME" "$APP_DIR"

# systemd: install services with correct user/group
sed "s/^User=.*/User=${USER_NAME}/; s/^Group=.*/Group=${USER_NAME}/" systemd/pocketagent.service > /etc/systemd/system/pocketagent.service
sed "s/^User=.*/User=${USER_NAME}/; s/^Group=.*/Group=${USER_NAME}/" systemd/pocketagent-reminders.service > /etc/systemd/system/pocketagent-reminders.service
sed "s/^User=.*/User=${USER_NAME}/; s/^Group=.*/Group=${USER_NAME}/" systemd/pocketagent-display.service > /etc/systemd/system/pocketagent-display.service
systemctl daemon-reload
systemctl enable pocketagent
systemctl enable pocketagent-reminders
systemctl enable pocketagent-display

echo "\nInstall complete. Next:"
echo "1) Edit /etc/default/pocketagent and set OPENAI_API_KEY=..."
echo "2) Reboot (Whisplay driver install requires it): sudo reboot"
echo "After reboot:"
echo "  sudo systemctl restart pocketagent-display pocketagent-reminders pocketagent"
echo "  sudo journalctl -u pocketagent-display -u pocketagent-reminders -u pocketagent -f"

echo ""
echo "Optional: Wi-Fi setup AP fallback (connect your phone to PocketAgent-Setup):"
echo "  sudo ./scripts/install_wifi_ap_fallback.sh"

echo ""
echo "Optional: offline Wi-Fi setup portal (adds saved networks via a phone web page):"
echo "  sudo ./scripts/install_wifi_portal.sh"
echo "  Then open: http://<pi-ip>:3792"
