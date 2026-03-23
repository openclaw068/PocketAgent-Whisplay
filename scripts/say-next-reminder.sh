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
    -d '{"id":"next-reminder-none","kind":"info","text":"You have no upcoming reminders."}' >/dev/null
  exit 0
fi

# Sort by dueAtIso and take the earliest
# Format dueAtIso into local time (AM/PM) using the configured timezone.
# jq's strftime is UTC-based; use `date` with TZ for correct local time.
tz="${POCKETAGENT_TIMEZONE:-${TZ:-America/Chicago}}"

next=$(printf '%s' "$json" | jq -r '.reminders | sort_by(.dueAtIso) | .[0] | {text, dueAtIso}')
rem_text=$(printf '%s' "$next" | jq -r '.text')
due_iso=$(printf '%s' "$next" | jq -r '.dueAtIso | sub("\\.\\d+Z$"; "Z")')
due_human=$(TZ="$tz" date -d "$due_iso" "+%A at %-I:%M %p")

text="Next reminder: ${rem_text}. Due ${due_human}"

# Ask PocketAgent to speak it (via notify queue)
# Use kind=info so PocketAgent reads it without the "did you do it yet?" follow-up flow.
curl -fsS -X POST "http://${NOTIFY_HOST}:${NOTIFY_PORT}/notify" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg t "$text" '{id:"next-reminder", kind:"info", text:$t}')" >/dev/null
