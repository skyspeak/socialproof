#!/bin/bash
# The back end for "X Bookmarks.app". It prints plain text for the app's
# dialogs and never prints a secret. Installed as ~/.x_reader/helper.sh by
# `schedule_macos.sh app`.
#
#   helper.sh status              last run and next run, in words
#   helper.sh sync                run a sync now, then say how it went
#   helper.sh apply-cookies FILE  save a new X login (two lines: auth_token, ct0)
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE" || exit 1
PLIST="${X_READER_PLIST:-$HOME/Library/LaunchAgents/com.skyspeak.x_reader.plist}"

last_log() { ls -1t logs/sync-*.log 2>/dev/null | head -1; }

friendly() {
  case "$1" in
    *"not signed in"*)       echo "X has signed you out. Choose \"Update X login\"." ;;
    *"rejected the secret"*) echo "Trendwire rejected the secret. Check TRENDWIRE_BOOKMARK_SECRET in ~/.x_reader/.env." ;;
    *unreachable*)           echo "Trendwire could not be reached. It will retry on the next run." ;;
    *)                       echo "${1:0:140}" ;;
  esac
}

describe_last_run() {
  local log start block when rc problem newn sent
  log="$(last_log)"
  [ -n "$log" ] || { echo "No sync has run yet."; return; }
  start="$(grep -n '^=== .* sync ===$' "$log" | tail -1 | cut -d: -f1)"
  [ -n "$start" ] || { echo "No sync has run yet."; return; }
  block="$(tail -n +"$start" "$log")"
  when="$(printf '%s\n' "$block" | head -1 | sed -E 's/^=== (.*) sync ===$/\1/')"
  rc="$(printf '%s\n' "$block" | grep -E '^=== exit [0-9]+ ===$' | tail -1 | sed -E 's/^=== exit ([0-9]+) ===$/\1/')"
  problem="$(printf '%s\n' "$block" | grep -m1 -E 'not signed in|rejected the secret|unreachable|Traceback|^error:')"
  newn="$(printf '%s\n' "$block" | grep -m1 'new bookmark')"
  sent="$(printf '%s\n' "$block" | grep -m1 '^trendwire: sent' \
    | sed -E 's/^trendwire: sent ([0-9]+), failed ([0-9]+), given up ([0-9]+), ([0-9]+) waiting$/Sent \1 to Trendwire, \2 failed, \4 still waiting./')"

  if [ -z "$rc" ]; then
    echo "Last run: $when. It did not finish."
  elif [ -n "$problem" ] || [ "$rc" != "0" ]; then
    echo "Last run: $when. Problem: $(friendly "${problem:-the sync stopped with an error}")"
  else
    echo "Last run: $when. OK. ${newn:-Nothing new.}${newn:+.}${sent:+ $sent}"
  fi
}

next_run() {
  local hh mm now
  if [ ! -f "$PLIST" ]; then echo "Not scheduled."; return; fi
  hh="$(/usr/libexec/PlistBuddy -c 'Print :StartCalendarInterval:Hour' "$PLIST" 2>/dev/null)"
  mm="$(/usr/libexec/PlistBuddy -c 'Print :StartCalendarInterval:Minute' "$PLIST" 2>/dev/null)"
  [ -n "$hh" ] || { echo "Scheduled."; return; }
  now=$((10#$(date +%H%M)))
  if [ "$now" -lt $((hh * 100 + mm)) ]; then
    printf 'Next automatic run: today at %02d:%02d.\n' "$hh" "$mm"
  else
    printf 'Next automatic run: tomorrow at %02d:%02d.\n' "$hh" "$mm"
  fi
}

case "$1" in
  status)
    describe_last_run
    next_run
    ;;
  sync)
    if pgrep -f "x_reader.py sync" >/dev/null 2>&1; then
      echo "A sync is already running. Try again in a few minutes."
      exit 0
    fi
    bash ./run.sh
    describe_last_run
    ;;
  apply-cookies)
    f="$2"
    [ -f "$f" ] || { echo "No login values were provided."; exit 1; }
    tok="$(sed -n 1p "$f" | tr -d '[:space:]')"
    ct="$(sed -n 2p "$f" | tr -d '[:space:]')"
    rm -f "$f"
    if ! [[ "$tok" =~ ^[0-9a-fA-F]{20,}$ ]]; then
      echo "That does not look like an auth_token (a long run of digits and letters a to f). Nothing was changed."
      exit 1
    fi
    if ! [[ "$ct" =~ ^[0-9a-fA-F]{20,}$ ]]; then
      echo "That does not look like a ct0 value (a long run of digits and letters a to f). Nothing was changed."
      exit 1
    fi
    umask 077
    { grep -v -E '^X_(AUTH_TOKEN|CT0)=' .env 2>/dev/null || true
      printf 'X_AUTH_TOKEN=%s\nX_CT0=%s\n' "$tok" "$ct"; } > .env.new \
      && mv .env.new .env && chmod 600 .env
    echo "Saved. The next sync will use the new login."
    ;;
  *)
    echo "usage: helper.sh status | sync | apply-cookies FILE" >&2
    exit 2
    ;;
esac
