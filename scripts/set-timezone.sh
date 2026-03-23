#!/usr/bin/env bash
set -euo pipefail

# Set system + PocketAgent timezone everywhere.
# Usage:
#   sudo /opt/pocketagent/scripts/set-timezone.sh America/Chicago

TZ_NAME="${1:-}"
if [[ -z "$TZ_NAME" ]]; then
  echo "usage: $0 <IANA timezone>" >&2
  exit 2
fi

# 1) System timezone
# Don't pre-validate via list-timezones (it can behave inconsistently across environments).
# Instead, attempt to set and treat failure as invalid.
if ! sudo timedatectl set-timezone "$TZ_NAME"; then
  echo "Invalid timezone: $TZ_NAME" >&2
  echo "Tip: timedatectl list-timezones | grep -i <city>" >&2
  exit 3
fi

# 2) PocketAgent env file
ENV_FILE="/etc/default/pocketagent"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE" >&2
  exit 4
fi

# Replace or append POCKETAGENT_TIMEZONE
if sudo grep -q '^POCKETAGENT_TIMEZONE=' "$ENV_FILE"; then
  # Use | delimiter so slashes in TZ_NAME (e.g. America/Los_Angeles) don't break sed.
  sudo sed -i "s|^POCKETAGENT_TIMEZONE=.*|POCKETAGENT_TIMEZONE=$TZ_NAME|" "$ENV_FILE"
else
  echo "POCKETAGENT_TIMEZONE=$TZ_NAME" | sudo tee -a "$ENV_FILE" >/dev/null
fi

# 3) Restart services so all processes pick it up
sudo systemctl restart pocketagent-reminders pocketagent-display pocketagent-pisugar-monitor pocketagent || true

# Show a short confirmation for logs
printf '{"ok":true,"timezone":"%s"}\n' "$TZ_NAME"
