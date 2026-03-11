# Setup AP fallback (offline Wi‑Fi provisioning)

PocketAgent can run an always-on fallback "setup AP" when it is not connected to Wi‑Fi.

## Defaults

- SSID: `PocketAgent-Setup`
- Password: `pocketagent`
- Portal URL (when connected to the setup AP): `http://192.168.4.1/`

## Change SSID / password

For security, do **not** commit your real setup credentials to git.
Set them locally on the Pi in `/etc/default/pocketagent`:

```bash
POCKETAGENT_SETUP_AP_SSID=PocketAgent-Setup
POCKETAGENT_SETUP_AP_PASS=pocketagent
```

Then restart:

```bash
sudo systemctl restart pocketagent-wifi-ap-fallback
```

## Notes

- The setup AP only starts when the device is **not connected** to Wi‑Fi.
- Once the device reconnects to a known network, the setup AP stops automatically.
