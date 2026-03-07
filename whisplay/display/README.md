# Whisplay Display Sidecar (WIP)

This directory will contain a small local HTTP service that renders PocketAgent status + text onto the PiSugar Whisplay HAT LCD.

## Dev mode

```bash
python3 whisplay/display/server.py
# then from another shell:
curl -s http://127.0.0.1:3782/health
curl -s -X POST http://127.0.0.1:3782/update \
  -H 'content-type: application/json' \
  -d '{"status":"thinking","line2":"Hello from PocketAgent"}'
```

## Env

- `POCKETAGENT_DISPLAY_HOST` (default `127.0.0.1`)
- `POCKETAGENT_DISPLAY_PORT` (default `3782`)
- `POCKETAGENT_DISPLAY_MODE` (auto|whisplay|stdout|off)
- `WHISPLAY_DRIVER_PATH` (default `/opt/Whisplay/Driver`)
