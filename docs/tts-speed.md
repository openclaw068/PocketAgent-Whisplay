# TTS speaking speed

PocketAgent supports an adjustable speaking speed via env var:

- `POCKETAGENT_TTS_SPEED` (number)
  - `1.0` = normal
  - `< 1.0` = slower
  - `> 1.0` = faster

## Recommended (repo-friendly) method: /etc/default/pocketagent

Add one line (no inline comments):

```bash
POCKETAGENT_TTS_SPEED=1.2
```

Then restart:

```bash
sudo systemctl restart pocketagent
```

## Alternative: systemd drop-in override

If you prefer a systemd override (or want to ensure it loads even when `EnvironmentFile` parsing is finicky), create:

`/etc/systemd/system/pocketagent.service.d/override.conf`

```ini
[Service]
Environment=POCKETAGENT_TTS_SPEED=1.2
```

Apply:

```bash
sudo systemctl daemon-reload
sudo systemctl restart pocketagent
```

## Verify

`systemctl show -p Environment` may not always display variables loaded from `EnvironmentFile`.
The most reliable check is:

```bash
sudo systemctl cat pocketagent | grep -n POCKETAGENT_TTS_SPEED
```
