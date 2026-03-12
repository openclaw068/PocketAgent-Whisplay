# Setup AP fallback (offline Wi‑Fi provisioning)

PocketAgent can run a "setup AP" for Wi‑Fi provisioning.

It supports two modes:
- **Fallback mode (default):** Only starts the AP when the uplink is NOT connected.
- **Always-on concurrent mode (optional):** Keeps the AP up while also staying connected to an uplink (requires driver support for AP+client concurrency).

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

### Concurrent mode settings (optional; advanced)

If you want to keep your uplink connected (for Tailscale/SSH) *while also* broadcasting the setup AP, you can try concurrent mode.

**Warning:** This is hardware/driver dependent. Also, if you already have a system dnsmasq running, you may hit port conflicts.

```bash
# Uplink interface (internet). Usually wlan0.
POCKETAGENT_UPLINK_IFACE=wlan0

# AP interface. Recommended: ap0 (created on top of wlan0).
POCKETAGENT_AP_IFACE=ap0

# Keep the setup AP up even if uplink is connected.
POCKETAGENT_SETUP_AP_ALWAYS_ON=true

# Then enable the ap-iface helper:
sudo systemctl enable --now pocketagent-ap-iface
```

Then restart:

```bash
sudo systemctl restart pocketagent-wifi-ap-fallback
```

## Notes

- The setup AP only starts when the device is **not connected** to Wi‑Fi.
- Once the device reconnects to a known network, the setup AP stops automatically.
