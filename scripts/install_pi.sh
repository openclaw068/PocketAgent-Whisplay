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

# Optional: PiSugar Power Manager (battery)
# - If installed, PocketAgent can show battery percent/icon on the Whisplay LCD.
# - This install is interactive (model/auth prompts). We'll prompt unless POCKETAGENT_INSTALL_PISUGAR is set.
INSTALL_PISUGAR_RAW="${POCKETAGENT_INSTALL_PISUGAR:-}"
INSTALL_PISUGAR=""
if [[ -n "$INSTALL_PISUGAR_RAW" ]]; then
  INSTALL_PISUGAR="${INSTALL_PISUGAR_RAW}"
else
  read -r -p "Install PiSugar Power Manager (battery service) for battery icon? (y/N): " INSTALL_PISUGAR
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
  raspi-config \
  netcat-openbsd \
  jq

# ---- Optional: Tailscale install (remote access) ----
# We install Tailscale via the official script and enable the service.
# Auth is intentionally left to the user because it requires a one-time login / auth key.
INSTALL_TAILSCALE_NORM=$(echo "${INSTALL_TAILSCALE:-}" | tr '[:upper:]' '[:lower:]')
if [[ "${INSTALL_TAILSCALE_NORM}" == "y" || "${INSTALL_TAILSCALE_NORM}" == "yes" || "${INSTALL_TAILSCALE_NORM}" == "true" || "${INSTALL_TAILSCALE_NORM}" == "1" ]]; then
  echo "[install_pi] Installing Tailscale…"
  apt-get install -y --no-install-recommends curl
  curl -fsSL https://tailscale.com/install.sh | sh
  systemctl enable --now tailscaled || true
  echo "[install_pi] Tailscale installed. Next: sudo tailscale up"
  echo "[install_pi] Tip: if you're headless, run 'sudo tailscale up' and open the login URL it prints."
fi

# ---- Optional: PiSugar Power Manager install (battery service) ----
INSTALL_PISUGAR_NORM=$(echo "${INSTALL_PISUGAR:-}" | tr '[:upper:]' '[:lower:]')
if [[ "${INSTALL_PISUGAR_NORM}" == "y" || "${INSTALL_PISUGAR_NORM}" == "yes" || "${INSTALL_PISUGAR_NORM}" == "true" || "${INSTALL_PISUGAR_NORM}" == "1" ]]; then
  echo "[install_pi] Installing PiSugar Power Manager (interactive)…"
  echo "[install_pi] This will prompt you for a couple of one-time setup options."
  tmpdir=$(mktemp -d)
  wget -O "${tmpdir}/pisugar-power-manager.sh" https://cdn.pisugar.com/release/pisugar-power-manager.sh
  bash "${tmpdir}/pisugar-power-manager.sh" -c release
  rm -rf "${tmpdir}" || true

  echo "[install_pi] PiSugar install done. Verify: systemctl status pisugar-server"
  echo "[install_pi] Socket should exist: /tmp/pisugar-server.sock"
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

# Ensure timezone data/tooling is present (timedatectl). Usually installed, but safe.
apt-get install -y --no-install-recommends tzdata >/dev/null 2>&1 || true

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

# Whisplay LCD needs SPI (and typically I2C). Many fresh Bookworm images ship with
# interfaces disabled → no /dev/spidev* and the display backend can't initialize.
#
# Default behavior: if SPI device nodes are missing, auto-enable SPI+I2C via raspi-config
# (non-interactive) and instruct the user to reboot.
# Set POCKETAGENT_ENABLE_SPI_I2C=false to skip.
ENABLE_SPI_I2C_RAW="${POCKETAGENT_ENABLE_SPI_I2C:-true}"
ENABLE_SPI_I2C=$(echo "${ENABLE_SPI_I2C_RAW}" | tr '[:upper:]' '[:lower:]')

if ! ls /dev/spidev* >/dev/null 2>&1; then
  if [[ "${ENABLE_SPI_I2C}" == "false" || "${ENABLE_SPI_I2C}" == "0" || "${ENABLE_SPI_I2C}" == "no" || "${ENABLE_SPI_I2C}" == "n" ]]; then
    echo "[install_pi] NOTE: /dev/spidev* not found. Enable SPI (and I2C) then reboot:" 
    echo "  sudo raspi-config  # Interface Options → SPI/I2C → Enable" 
    echo "  sudo reboot" 
  else
    if command -v raspi-config >/dev/null 2>&1; then
      echo "[install_pi] Enabling SPI + I2C (needed for Whisplay LCD)…"
      raspi-config nonint do_spi 0 || true
      raspi-config nonint do_i2c 0 || true
      echo "[install_pi] SPI/I2C enabled. Reboot required: sudo reboot"
    else
      echo "[install_pi] NOTE: /dev/spidev* not found and raspi-config missing; enable SPI/I2C then reboot:" 
      echo "  sudo apt-get install -y raspi-config" 
      echo "  sudo raspi-config  # Interface Options → SPI/I2C → Enable" 
      echo "  sudo reboot" 
    fi
  fi
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

# Install helper scripts into /opt/pocketagent/scripts
install -d -m 755 -o root -g root /opt/pocketagent/scripts
install -m 755 -o root -g root "$APP_DIR/scripts/set-timezone.sh" /opt/pocketagent/scripts/set-timezone.sh
install -m 755 -o root -g root "$APP_DIR/scripts/say-next-reminder.sh" /opt/pocketagent/scripts/say-next-reminder.sh

# Allow PocketAgent (runs as USER_NAME) to update timezone without interactive sudo.
# Restrict to a single script path for safety.
SUDOERS_FILE="/etc/sudoers.d/pocketagent-timezone"
echo "${USER_NAME} ALL=(root) NOPASSWD: /opt/pocketagent/scripts/set-timezone.sh *" > "$SUDOERS_FILE"
chmod 440 "$SUDOERS_FILE"

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
echo "1) Verify /etc/default/pocketagent (audio devices, PiSugar socket, display mode)"
echo "   sudo nano /etc/default/pocketagent"
echo "2) Reboot (Whisplay driver + SPI/I2C changes require it): sudo reboot"
echo "3) Restore known-good mixer state (recommended):"
echo "   cd /opt/pocketagent && sudo ./scripts/restore-audio-state.sh ./config/audio && sudo alsactl store"
echo "4) Optional but recommended (battery icon): install PiSugar Power Manager (interactive):"
echo "   Open: http://<pi-ip-address>:8421 to configure the PiSugar device"
echo "   wget -O pisugar-power-manager.sh https://cdn.pisugar.com/release/pisugar-power-manager.sh"
echo "   bash pisugar-power-manager.sh -c release"
echo "After reboot / install:"
echo "  sudo systemctl restart pocketagent-display pocketagent-pisugar-monitor pocketagent-reminders pocketagent"
echo "  sudo journalctl -u pocketagent-display -u pocketagent-pisugar-monitor -u pocketagent -f"

echo ""
echo "Note: Wi‑Fi AP/hotspot setup tooling has been removed to avoid wlan firmware instability."
