#!/usr/bin/env bash
# Run x_reader's sync once a day on a Mac, with launchd.
#
#   ./schedule_macos.sh install [HH:MM]   default 15:00, local time
#   ./schedule_macos.sh status
#   ./schedule_macos.sh run-now           run a sync now, through launchd
#   ./schedule_macos.sh app               build "X Bookmarks.app" (no terminal needed)
#   ./schedule_macos.sh uninstall [--purge]
#
# Why a separate runtime directory (~/.x_reader) rather than running from the
# repo: macOS blocks background jobs from reading ~/Documents, ~/Desktop and
# ~/Downloads without extra permission, and a job that lives in a git clone
# stops the day the clone is deleted. The installer copies the script, your
# .env and what has been synced so far there, and builds its own Python
# environment. Re-run `install` after changing x_reader.py to refresh the copy.
#
# A laptop job: it fires at the set time if the Mac is awake, or when it next
# wakes. It cannot run while the Mac is off or you are logged out.
set -euo pipefail

LABEL="com.skyspeak.x_reader"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME="${X_READER_HOME:-$HOME/.x_reader}"
AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
cmd="${1:-}"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

do_install() {
  local when="${1:-15:00}" hh mm py
  [[ "$when" =~ ^([01]?[0-9]|2[0-3]):([0-5][0-9])$ ]] || die "time must be HH:MM, got '$when'"
  hh=$((10#${BASH_REMATCH[1]})); mm=$((10#${BASH_REMATCH[2]}))

  for c in python3.13 python3.12 python3.11; do
    if command -v "$c" >/dev/null 2>&1; then py="$(command -v "$c")"; break; fi
  done
  [ -n "${py:-}" ] || die "x_reader needs Python 3.11 or newer (brew install python@3.13)"

  mkdir -p "$RUNTIME/logs"
  if [ ! -x "$RUNTIME/.venv/bin/python" ]; then
    say "creating Python environment with $py"
    "$py" -m venv "$RUNTIME/.venv"
    "$RUNTIME/.venv/bin/pip" install -q --disable-pip-version-check \
      httpx playwright trafilatura pypdf python-dotenv vaderSentiment
    "$RUNTIME/.venv/bin/python" -m playwright install chromium
  fi

  cp "$HERE/x_reader.py" "$RUNTIME/x_reader.py"
  [ -f "$RUNTIME/helper.sh" ] && cp "$HERE/app_helper.sh" "$RUNTIME/helper.sh"

  if [ ! -f "$RUNTIME/.env" ]; then
    [ -f "$HERE/.env" ] || die "no .env found in $HERE — create one first (see .env.example)"
    cp "$HERE/.env" "$RUNTIME/.env" && chmod 600 "$RUNTIME/.env"
    say "copied .env"
  fi
  if [ ! -d "$RUNTIME/xreader_data" ] && [ -d "$HERE/xreader_data" ]; then
    mkdir -p "$RUNTIME/xreader_data"
    rsync -a --exclude browser_profile "$HERE/xreader_data/" "$RUNTIME/xreader_data/"
    say "carried over earlier sync state (so nothing is fetched or sent twice)"
  fi
  # The rendered PDFs live under site/, which is rebuilt, but the PDFs are not.
  if [ -d "$HERE/site/pdf" ] && [ ! -d "$RUNTIME/site/pdf" ]; then
    mkdir -p "$RUNTIME/site" && rsync -a "$HERE/site/pdf/" "$RUNTIME/site/pdf/"
  fi

  cat > "$RUNTIME/run.sh" <<'RUN'
#!/bin/bash
# One daily sync. Appends to logs/sync-YYYY-MM-DD.log and raises a macOS
# notification if it failed or X or Trendwire rejected us. A bad run should be
# visible; a quiet one should be quiet.
cd "$(dirname "$0")" || exit 1
mkdir -p logs
LOG="logs/sync-$(date +%Y-%m-%d).log"
OUT="$(mktemp)"

{ echo "=== $(date '+%Y-%m-%d %H:%M:%S %Z') sync ==="; } >> "$LOG"
./.venv/bin/python x_reader.py sync --limit "${X_READER_LIMIT:-15}" > "$OUT" 2>&1
rc=$?
cat "$OUT" >> "$LOG"
echo "=== exit $rc ===" >> "$LOG"

problem="$(grep -m1 -E "not signed in|rejected the secret|unreachable|Traceback|^error:" "$OUT")"
rm -f "$OUT"
if [ "$rc" -ne 0 ] || [ -n "$problem" ]; then
  msg="${problem:-sync exited with $rc}"; msg="${msg//\"/}"; msg="${msg//\\/}"
  osascript -e "display notification \"${msg:0:180}\" with title \"x_reader\" subtitle \"see ~/.x_reader/logs\"" >/dev/null 2>&1
fi
find logs -name 'sync-*.log' -mtime +30 -delete 2>/dev/null
exit "$rc"
RUN
  chmod 755 "$RUNTIME/run.sh"

  cat > "$AGENT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$RUNTIME/run.sh</string></array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>$hh</integer><key>Minute</key><integer>$mm</integer></dict>
  <key>StandardOutPath</key><string>$RUNTIME/logs/launchd.out</string>
  <key>StandardErrorPath</key><string>$RUNTIME/logs/launchd.err</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
</dict>
</plist>
PLIST
  plutil -lint "$AGENT" >/dev/null

  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "$DOMAIN" "$AGENT"
  launchctl enable "$DOMAIN/$LABEL"
  printf 'installed: sync runs daily at %02d:%02d local time\n' "$hh" "$mm"
  say "runtime: $RUNTIME   logs: $RUNTIME/logs"
}

status() {
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    say "scheduled: yes"
    launchctl print "$DOMAIN/$LABEL" | grep -E "state =|runs =|last exit code|Hour|Minute" | sed 's/^[[:space:]]*/  /'
  else
    say "scheduled: no"
  fi
  local last; last="$(ls -1t "$RUNTIME"/logs/sync-*.log 2>/dev/null | head -1 || true)"
  if [ -n "$last" ]; then say "latest log: $last"; tail -n 12 "$last" | sed 's/^/  /'; else say "no runs logged yet"; fi
}

build_app() {
  [ -d "$RUNTIME" ] || die "run './schedule_macos.sh install' first"
  command -v osacompile >/dev/null 2>&1 || die "osacompile not found (it ships with macOS)"
  cp "$HERE/app_helper.sh" "$RUNTIME/helper.sh" && chmod 755 "$RUNTIME/helper.sh"
  mkdir -p "$HOME/Applications"
  rm -rf "$HOME/Applications/X Bookmarks.app"
  osacompile -o "$HOME/Applications/X Bookmarks.app" "$HERE/X Bookmarks.applescript"
  say "built ~/Applications/X Bookmarks.app"
  say "open it from Spotlight (Command-Space, then 'X Bookmarks'), or drag it to the Dock"
}

case "$cmd" in
  app)       build_app ;;
  install)   shift; do_install "$@" ;;
  status)    status ;;
  run-now)   launchctl kickstart -k "$DOMAIN/$LABEL" && say "started; follow with: tail -f $RUNTIME/logs/sync-\$(date +%Y-%m-%d).log" ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
    rm -f "$AGENT"; say "unscheduled"
    if [ "${2:-}" = "--purge" ]; then rm -rf "$RUNTIME"; say "removed $RUNTIME"; else say "kept $RUNTIME (your session cookies and sync state); --purge removes it"; fi ;;
  *) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
