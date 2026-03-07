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
This is usually mixer routing/mute on the WM8960. First open the WM8960 mixer:
```bash
alsamixer -c 1  # press F6, select wm8960-soundcard
```

If you prefer command-line (and to make it reproducible), force-enable the common WM8960 playback path:
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

# The installer pre-fills a working baseline for:
# - WM8960 audio (plughw:1,0)
# - ULTRA++ PTT button (chip=0, line=23, active-low)
# - Stable button tuning (min-hold/debounce/cooldown)
# - Default mode: chat (neutral voice agent, press-to-talk per turn)

sudo systemctl start pocketagent
sudo journalctl -u pocketagent -f
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

## Notes on Piper (offline TTS)
Piper can be great on a Pi 4/5, but on a **Pi Zero 2W** it’s usually borderline for latency and voice quality depending on the model and settings. For v0.1 we default to OpenAI TTS for reliability; we can add a Piper option later and benchmark.
