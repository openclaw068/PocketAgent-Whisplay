#!/usr/bin/env bash
set -euo pipefail

# Speak the next upcoming open reminder using PocketAgent.
# Requires:
# - pocketagent-reminders daemon running on localhost:3791
# - pocketagent notify server listening on localhost:3781 (/notify)
# - jq installed
#
# Usage:
#   sudo bash /opt/pocketagent/scripts/say-next-reminder.sh

REM_HOST="${POCKETAGENT_REMINDERS_HOST:-127.0.0.1}"
REM_PORT="${POCKETAGENT_REMINDERS_PORT:-3791}"
NOTIFY_HOST="${POCKETAGENT_NOTIFY_HOST:-127.0.0.1}"
NOTIFY_PORT="${POCKETAGENT_NOTIFY_PORT:-3781}"

# Fetch open reminders
json=$(curl -fsS "http://${REM_HOST}:${REM_PORT}/reminders/open")

# If none, ask PocketAgent to say that.
count=$(printf '%s' "$json" | jq -r '.reminders | length')
if [[ "$count" == "0" ]]; then
  curl -fsS -X POST "http://${NOTIFY_HOST}:${NOTIFY_PORT}/notify" \
    -H 'Content-Type: application/json' \
    -d '{"id":"next-reminder-none","kind":"reminder","text":"You have no upcoming reminders."}' >/dev/null
  exit 0
fi

# Sort by dueAtIso and take the earliest
# Format dueAtIso into local time (AM/PM) using the system timezone.
# NOTE: Ensure the Pi's timezone is set correctly (e.g., America/Chicago).
text=$(printf '%s' "$json" | jq -r '.reminders
  | sort_by(.dueAtIso)
  | .[0]
  | . as $r
  | "Next reminder: \($r.text). Due \(($r.dueAtIso | fromdateiso8601) | strftime("%l:%M %p"))"')

# Ask PocketAgent to speak it (via notify queue)
curl -fsS -X POST "http://${NOTIFY_HOST}:${NOTIFY_PORT}/notify" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg t "$text" '{id:"next-reminder", kind:"reminder", text:$t}')" >/dev/null
