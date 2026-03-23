# PocketAgent

Pocketable Raspberry Pi voice agent for Raspberry Pi Zero 2W:

- Hold-to-talk button → record mic → **Whisper** (OpenAI) → agent logic
- Agent replies through speaker (TTS)
- Reminders that repeat until you confirm “done”

## Status (v0.1)
This repo contains a working skeleton:
- Audio record/play via ALSA (`arecord` / `aplay`)
- Transcribe via OpenAI Audio Transcriptions
- TTS via OpenAI Audio Speech
- Local reminder scheduler with follow-ups
- After each spoken reminder, it listens briefly for a “yes/done” to auto-clear
- **Push-to-talk button supported via `gpiomon` (libgpiod)** (defaults to ULTRA++ button on GPIO23)

### Modes
PocketAgent can run in two modes:
- **Reminders mode** (default): reminder creation + follow-ups
- **Chat mode**: neutral, general-purpose voice agent (hold-to-talk like ChatGPT)

Set with:
- `POCKETAGENT_MODE=reminders` (default)
- `POCKETAGENT_MODE=chat`

Chat mode keeps full conversation memory for the current run, and on restart it carries over the last N messages (default 10) from the previous run.

### Hands-free chat (optional)
By default chat mode is **press-to-talk per turn**.

To enable hands-free back-and-forth (auto-listen after each assistant reply):
```bash
POCKETAGENT_CHAT_AUTO_LISTEN=true
POCKETAGENT_CHAT_AUTO_LISTEN_MAX_TURNS=2

# Tuning knobs for ALSA stacks that are briefly busy right after playback:
POCKETAGENT_AUTO_LISTEN_DELAY_MS=800
POCKETAGENT_AUTO_LISTEN_RECORD_RETRIES=8
```

### Push-to-talk configuration
By default PocketAgent uses GPIO push-to-talk.
- `POCKETAGENT_PTT_MODE=gpio` (default)
- `POCKETAGENT_PTT_GPIO_LINE=23` (ULTRA++ button)
- `POCKETAGENT_GPIO_CHIP=0` (recommended; some gpiod builds want a chip number, not name)
- `POCKETAGENT_PTT_ACTIVE_LOW=true` (recommended for ULTRA++; button pin has an external pull-up)
- If you want dev mode: `POCKETAGENT_PTT_MODE=stdin` (press ENTER)

## Requirements
- Raspberry Pi OS (Bookworm recommended; tested target: Pi Zero 2 W + Raspberry Pi OS Lite 64-bit Bookworm)
- Node.js 20+ recommended
- `alsa-utils` (provides `arecord`, `aplay`, `alsamixer`)
- `gpiod` / libgpiod tools (provides `gpiomon`)
- `OPENAI_API_KEY` set

## Common fresh-install pitfalls
### `git: command not found`
Some Bookworm Lite images don’t include `git`.

Fix:
```bash
sudo apt-get update
sudo apt-get install -y git ca-certificates curl
```

### Adding fallback Wi‑Fi networks (NetworkManager)
On Bookworm, Wi‑Fi is often managed by **NetworkManager**. If you used `wpa_cli` to add networks and `save_config` fails, that’s expected — NetworkManager doesn’t persist through wpa_supplicant config writes.

Instead, create saved connections with `nmcli` and set **autoconnect priorities**:
- higher number = preferred
- lower number = fallback

Example (main = IoT, fallbacks = iPhone + Kolmer):
```bash
# Create fallback profiles even if the SSID is not currently visible
sudo nmcli con add type wifi ifname wlan0 con-name "iPhone" ssid "iPhone"
sudo nmcli con modify "iPhone" wifi-sec.key-mgmt wpa-psk wifi-sec.psk "Zombie@22" connection.autoconnect yes connection.autoconnect-priority -10

sudo nmcli con add type wifi ifname wlan0 con-name "Kolmer" ssid "Kolmer"
sudo nmcli con modify "Kolmer" wifi-sec.key-mgmt wpa-psk wifi-sec.psk "Columbus1" connection.autoconnect yes connection.autoconnect-priority -10

# If your main Wi‑Fi profile has a generic name (often "preconfigured"), rename it:
sudo nmcli con modify "preconfigured" connection.id "IoT"

# Prefer the main network
sudo nmcli con modify "IoT" connection.autoconnect yes connection.autoconnect-priority 10

# Verify
sudo nmcli -f NAME,TYPE,AUTOCONNECT,AUTOCONNECT-PRIORITY con show | egrep 'IoT|iPhone|Kolmer'
```

## ULTRA++ audio driver (wm8960)
On up-to-date Raspberry Pi OS, the ULTRA++ / WM8960 driver is often auto-detected.

If audio doesn’t show up in `aplay -l` / `arecord -l`, add the overlay and reboot:

- Edit (Bookworm): `/boot/firmware/config.txt`
- Add at the end:
  - `dtoverlay=wm8960-soundcard`

Then reboot and verify:
```bash
aplay -l
arecord -l
```

### If `arecord` / `aplay` fail on the default device (common on Bookworm)
On some Bookworm images you may see errors like:
- `ALSA lib pcm_asym.c:... capture slave is not defined`
- `audio open error: Invalid argument`

In that case, the **WM8960 device is fine**, but the ALSA `default` device is misconfigured.
Use the WM8960 hardware device explicitly:
```bash
# WM8960 is usually card 1, device 0 when HDMI is card 0
arecord -D plughw:1,0 -f S16_LE -c1 -r 16000 -d 5 test.wav
aplay  -D plughw:1,0 test.wav

# quick playback sanity check
aplay -D plughw:1,0 /usr/share/sounds/alsa/Front_Center.wav
```

### If you get "no sound" even though playback succeeds
This is usually **mixer routing/mute** on the WM8960.

### If the Whisplay LCD doesn't show anything
On a fresh Pi OS install, SPI/I2C are often disabled.

Symptoms:
- display service runs, but logs show something like: `Whisplay backend unavailable: [Errno 2] No such file or directory`
- and you have no `/dev/spidev*` (and often no `/dev/i2c*`)

Fix:
```bash
sudo raspi-config
# Interface Options → SPI → Enable
# Interface Options → I2C → Enable
sudo reboot
```
Then restart the display service:
```bash
sudo systemctl restart pocketagent-display
sudo journalctl -u pocketagent-display -n 50 --no-pager
```

### Battery icon not showing
The battery indicator comes from **PiSugar Power Manager** (`pisugar-server`).

#### Install PiSugar Power Manager (one-time)
Run PiSugar's installer (it includes a short interactive setup):
```bash
wget -O pisugar-power-manager.sh https://cdn.pisugar.com/release/pisugar-power-manager.sh
bash pisugar-power-manager.sh -c release
```

#### Verify PiSugar is running
After install, you can access the PiSugar management UI at:
- `http://<pi-ip-address>:8421`

Then verify the service/socket:
```bash
systemctl status --no-pager pisugar-server
ls -la /tmp/pisugar-server.sock
```

#### Quick battery query
```bash
echo "get battery" | nc -U -q 0 /tmp/pisugar-server.sock
echo "get battery_power_plugged" | nc -U -q 0 /tmp/pisugar-server.sock
```

If `nc` isn't installed:
```bash
sudo apt-get update
sudo apt-get install -y netcat-openbsd
```

#### Preferred (reproducible): restore the known-good mixer state from this repo
PocketAgent-Whisplay includes a saved ALSA state and a helper script.

After install (or any time audio gets weird):
```bash
cd /opt/pocketagent
sudo ./scripts/restore-audio-state.sh ./config/audio
sudo alsactl store

# sanity check
aplay -D plughw:1,0 /usr/share/sounds/alsa/Front_Center.wav
```

#### Manual fallback (alsamixer)
First open the WM8960 mixer:
```bash
alsamixer -c 1  # press F6, select wm8960-soundcard
```

#### Manual fallback (amixer CLI)
If you prefer command-line, force-enable the common WM8960 playback path:
```bash
# route PCM into the output mixers
amixer -c 1 sset 'Left Output Mixer PCM' on
amixer -c 1 sset 'Right Output Mixer PCM' on

# ensure outputs aren’t muted/attenuated
amixer -c 1 sset 'PCM Playback -6dB' on
amixer -c 1 sset Speaker 127
amixer -c 1 sset Headphone 127
amixer -c 1 sset Playback 255

aplay -D plughw:1,0 /usr/share/sounds/alsa/Front_Center.wav
```

To persist the working mixer state across reboots:
```bash
sudo alsactl store
```

## Quick start (dev)
```bash
npm install
export OPENAI_API_KEY="..."
node pocketagent/index.js
# press ENTER to simulate a button press
```

## Install on Pi (systemd)
```bash
sudo bash scripts/install_pi.sh
sudo nano /etc/default/pocketagent   # set OPENAI_API_KEY="sk-..." (quotes recommended)

# Then apply the repo's known-good mixer routing:
cd /opt/pocketagent
sudo ./scripts/restore-audio-state.sh ./config/audio
sudo alsactl store

sudo systemctl restart pocketagent-display pocketagent-pisugar-monitor pocketagent-reminders pocketagent
sudo journalctl -u pocketagent-display -u pocketagent-pisugar-monitor -u pocketagent -f
```

### Important: don't edit files in /opt/pocketagent directly
If you need to debug, avoid one-off `sed -i` edits inside `/opt/pocketagent` services (they can break boot). Instead:
- change settings in `/etc/default/pocketagent`
- or make the change in this repo and `git pull`

If you *did* accidentally add a bad line and a service crash-loops, fix by:
```bash
sudo systemctl reset-failed pocketagent-pisugar-monitor
cd /opt/pocketagent
sudo git checkout -- pocketagent/pisugar_monitor_daemon.js
sudo systemctl restart pocketagent-pisugar-monitor
```

## AirPlay volume (phone-controlled) + fixed assistant volume
If you use **Shairport Sync** for AirPlay, you may run into this failure mode:
- You lower AirPlay volume from your phone
- It silently lowers the ALSA hardware mixer (e.g. `Playback`)
- After AirPlay ends, PocketAgent becomes **quiet**

The fix is:
- Shairport Sync uses **software volume** (phone controls AirPlay loudness)
- Shairport Sync does **not** write to the ALSA hardware mixer
- Remove any post-play hooks (or systemd `ExecStartPre`) that reset volume

### Apply the known-good fix
From the repo root:
```bash
sudo ./scripts/apply-audio-airplay-fix.sh
```

Details: see `docs/audio-airplay-volume.md`.

### Recommended baseline (known-good on Pi Zero 2 W + ULTRA++ / WM8960)
Put these in `/etc/default/pocketagent` (ONE per line):
```bash
OPENAI_API_KEY="sk-..."

POCKETAGENT_MODE=chat
POCKETAGENT_CHAT_CARRYOVER_COUNT=10

POCKETAGENT_RECORDING_DEVICE=plughw:1,0
POCKETAGENT_PLAYBACK_DEVICE=plughw:1,0

POCKETAGENT_GPIO_CHIP=0
POCKETAGENT_PTT_GPIO_LINE=17
POCKETAGENT_PTT_ACTIVE_LOW=false

POCKETAGENT_PTT_MIN_HOLD_MS=600
POCKETAGENT_PTT_DEBOUNCE_MS=80
POCKETAGENT_PTT_COOLDOWN_MS=200

POCKETAGENT_PROMPT_ON_PRESS=false
```

### Optional: hands-free chat (auto-listen)
On some ALSA stacks, recording immediately after playback can fail intermittently. If you still want hands-free:
```bash
POCKETAGENT_CHAT_AUTO_LISTEN=true
POCKETAGENT_CHAT_AUTO_LISTEN_MAX_TURNS=5
POCKETAGENT_AUTO_LISTEN_SECONDS=6
POCKETAGENT_AUTO_LISTEN_DELAY_MS=2000
POCKETAGENT_AUTO_LISTEN_RECORD_RETRIES=20
```

### First-boot checklist (if something doesn’t work)
```bash
# 1) Verify the sound card exists
aplay -l
arecord -l

# 2) Verify capture/playback
arecord -f cd -d 5 test.wav
aplay test.wav

# 3) Verify the push-to-talk button emits edges
gpiomon --help | head
sudo gpiomon -n -F %E -s gpiochip0 23
```

## Double-press helper: speak next upcoming reminder
If you map the extra PiSugar/Whisplay button actions to shell commands, you can make PocketAgent speak your next reminder.

Run:
```bash
sudo bash /opt/pocketagent/scripts/say-next-reminder.sh
```

### Timezone (important)
The helper formats due times using the Pi's local timezone. Set it once (Central US):
```bash
sudo timedatectl set-timezone America/Chicago

# verify
timedatectl | sed -n '1,8p'
```

## Notes on Piper (offline TTS)
Piper can be great on a Pi 4/5, but on a **Pi Zero 2W** it’s usually borderline for latency and voice quality depending on the model and settings. For v0.1 we default to OpenAI TTS for reliability; we can add a Piper option later and benchmark.
