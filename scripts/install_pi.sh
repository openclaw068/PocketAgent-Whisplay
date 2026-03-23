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

# Optional: Tailscale
# - Set POCKETAGENT_INSTALL_TAILSCALE=true to enable non-interactively.
# - If unset, installer will prompt.
INSTALL_TAILSCALE_RAW="${POCKETAGENT_INSTALL_TAILSCALE:-}"
INSTALL_TAILSCALE=""
if [[ -n "$INSTALL_TAILSCALE_RAW" ]]; then
  INSTALL_TAILSCALE="${INSTALL_TAILSCALE_RAW}"
else
  read -r -p "Install Tailscale for remote access? (y/N): " INSTALL_TAILSCALE
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
  python3-spidev \
  raspi-config

# ---- Optional: Tailscale install (remote access) ----
# We install Tailscale via the official script and enable the service.
# Auth (tailscale up) is intentionally left to the user because it requires a one-time login key / interactive auth.
INSTALL_TAILSCALE_NORM=$(echo "${INSTALL_TAILSCALE:-}" | tr '[:upper:]' '[:lower:]')
if [[ "${INSTALL_TAILSCALE_NORM}" == "y" || "${INSTALL_TAILSCALE_NORM}" == "yes" || "${INSTALL_TAILSCALE_NORM}" == "true" || "${INSTALL_TAILSCALE_NORM}" == "1" ]]; then
  echo "[install_pi] Installing Tailscale…"
  apt-get install -y --no-install-recommends curl
  curl -fsSL https://tailscale.com/install.sh | sh
  systemctl enable --now tailscaled || true
  echo "[install_pi] Tailscale installed. Next: sudo tailscale up"
fi

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

# Note: Whisplay LCD needs SPI (and typically I2C). Many fresh Bookworm images ship with
# interfaces disabled → no /dev/spidev* and the display backend can't initialize.
# We don't force-enable here (non-interactive), but we print a clear next-step reminder.
if ! ls /dev/spidev* >/dev/null 2>&1; then
  echo "[install_pi] NOTE: /dev/spidev* not found. Enable SPI (and I2C) then reboot:" 
  echo "  sudo raspi-config  # Interface Options → SPI/I2C → Enable" 
  echo "  sudo reboot" 
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
  # Use versioned template tracked in repo.
  # Write placeholder first, then fill in OPENAI_API_KEY.
  install -m 600 -o root -g root "$APP_DIR/config/pocketagent.env.example" /etc/default/pocketagent

  # Replace placeholder with key (escape backslashes/quotes)
  esc_key=$(printf '%s' "$OPENAI_KEY" | sed 's/\\/\\\\/g; s/"/\\"/g')
  sed -i "s/^OPENAI_API_KEY=\"sk-REPLACE_ME\"/OPENAI_API_KEY=\"${esc_key}\"/" /etc/default/pocketagent
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
sed "s/^User=.*/User=${USER_NAME}/; s/^Group=.*/Group=${USER_NAME}/" systemd/pocketagent-pisugar-monitor.service > /etc/systemd/system/pocketagent-pisugar-monitor.service
systemctl daemon-reload
systemctl enable pocketagent
systemctl enable pocketagent-reminders
systemctl enable pocketagent-display
systemctl enable pocketagent-pisugar-monitor

echo "\nInstall complete. Next:"
echo "1) Edit /etc/default/pocketagent and set OPENAI_API_KEY=..."
echo "2) Reboot (Whisplay driver install requires it): sudo reboot"
echo "After reboot:"
echo "  sudo systemctl restart pocketagent-display pocketagent-reminders pocketagent"
echo "  sudo journalctl -u pocketagent-display -u pocketagent-reminders -u pocketagent -f"

echo ""
echo "Note: Wi‑Fi AP/hotspot setup tooling has been removed to avoid wlan firmware instability."
