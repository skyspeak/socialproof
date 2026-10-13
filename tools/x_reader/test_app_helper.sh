#!/bin/bash
# The back end of X Bookmarks.app: status wording, the login merge, and that a
# login value never reaches the output. No network, no X, no real ~/.x_reader.
#
#   bash tools/x_reader/test_app_helper.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
fail=0
check() { if [ "$2" = "0" ]; then echo "  ✓ $1"; else echo "  ✗ $1"; fail=$((fail + 1)); fi; }
has() { printf '%s' "$1" | grep -q -- "$2"; echo $?; }

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
cp "$HERE/app_helper.sh" "$T/helper.sh"; chmod +x "$T/helper.sh"
mkdir -p "$T/logs"
export X_READER_PLIST="$T/none.plist"

# --- before any run -----------------------------------------------------------
out="$("$T/helper.sh" status)"
check "no runs yet is said plainly"            "$(has "$out" 'No sync has run yet')"
check "an absent schedule is said plainly"     "$(has "$out" 'Not scheduled')"

# --- a good run ---------------------------------------------------------------------
cat > "$T/logs/sync-2026-10-12.log" <<'LOG'
=== 2026-10-12 17:32:54 PDT sync ===
5 new bookmark(s)
  [1/5] tweet   @a
trendwire: sent 5, failed 0, given up 0, 0 waiting
site built: x (5 items, 1 editions)
=== exit 0 ===
LOG
out="$("$T/helper.sh" status)"
check "a good run says OK"                      "$(has "$out" 'OK')"
check "it reports how many were new"            "$(has "$out" '5 new bookmark')"
check "it reports how many were sent"           "$(has "$out" 'Sent 5 to Trendwire')"
check "it reports how many failed"              "$(has "$out" '0 failed')"
check "it names when it ran"                    "$(has "$out" '2026-10-12 17:32:54 PDT')"

# --- the schedule line ---------------------------------------------------------------
cat > "$T/p.plist" <<'PL'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>StartCalendarInterval</key>
<dict><key>Hour</key><integer>15</integer><key>Minute</key><integer>0</integer></dict></dict></plist>
PL
export X_READER_PLIST="$T/p.plist"
out="$("$T/helper.sh" status)"
check "the next run is stated with its time"    "$(has "$out" 'Next automatic run: \(today\|tomorrow\) at 15:00')"

# --- a signed-out run ------------------------------------------------------------------
cat >> "$T/logs/sync-2026-10-12.log" <<'LOG'
=== 2026-10-13 15:00:02 PDT sync ===
error: not signed in to X. Run: login  (or set X_AUTH_TOKEN and X_CT0)
=== exit 1 ===
LOG
out="$("$T/helper.sh" status)"
check "the newest run is the one described"     "$(has "$out" '2026-10-13 15:00:02')"
check "a signed-out run points at the fix"      "$(has "$out" 'Update X login')"

# --- a run that never finished ------------------------------------------------------------
printf '=== 2026-10-14 15:00:00 PDT sync ===\n3 new bookmark(s)\n' >> "$T/logs/sync-2026-10-12.log"
out="$("$T/helper.sh" status)"
check "an unfinished run is not called OK"      "$(has "$out" 'did not finish')"

# --- saving a login ------------------------------------------------------------------------------
TOK="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
CT0="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
printf 'TRENDWIRE_URL=https://example.test\nX_AUTH_TOKEN=old\nX_CT0=old\nSUMMARY_BACKEND=none\n' > "$T/.env"
printf '%s\n%s\n' "$TOK" "$CT0" > "$T/c.tmp"
out="$("$T/helper.sh" apply-cookies "$T/c.tmp")"
check "a valid login is saved"                  "$(has "$out" 'Saved')"
check "the new auth_token is in .env"           "$(has "$(cat "$T/.env")" "X_AUTH_TOKEN=$TOK")"
check "the new ct0 is in .env"                  "$(has "$(cat "$T/.env")" "X_CT0=$CT0")"
check "the old values are gone"                 "$(printf '%s' "$(cat "$T/.env")" | grep -c '=old')"
check "other settings are kept"                 "$(has "$(cat "$T/.env")" 'SUMMARY_BACKEND=none')"
check "each key appears once"                   "$([ "$(grep -c '^X_AUTH_TOKEN=' "$T/.env")" = 1 ] && echo 0 || echo 1)"
check ".env is private"                         "$([ "$(stat -f %Lp "$T/.env")" = 600 ] && echo 0 || echo 1)"
check "the temp file is removed"                "$([ ! -e "$T/c.tmp" ] && echo 0 || echo 1)"
check "the login value is never printed"        "$(printf '%s' "$out" | grep -c "$TOK")"

# --- refusing a bad login -----------------------------------------------------------------------------
before="$(cat "$T/.env")"
printf 'not a token\n%s\n' "$CT0" > "$T/c.tmp"
out="$("$T/helper.sh" apply-cookies "$T/c.tmp")"; rc=$?
check "a bad auth_token is refused"             "$(has "$out" 'does not look like an auth_token')"
check "a refusal exits non-zero"                "$([ "$rc" != 0 ] && echo 0 || echo 1)"
check ".env is untouched by a refusal"          "$([ "$(cat "$T/.env")" = "$before" ] && echo 0 || echo 1)"
printf '%s\nshort\n' "$TOK" > "$T/c.tmp"
out="$("$T/helper.sh" apply-cookies "$T/c.tmp")"
check "a bad ct0 is refused"                    "$(has "$out" 'does not look like a ct0')"
printf '%s\n%s\n' "  $TOK  " "$CT0 " > "$T/c.tmp"
out="$("$T/helper.sh" apply-cookies "$T/c.tmp")"
check "stray spaces from a paste are tolerated" "$(has "$out" 'Saved')"
out="$("$T/helper.sh" apply-cookies "$T/missing.tmp")"
check "a missing file is reported"              "$(has "$out" 'No login values')"

# --- one at a time ----------------------------------------------------------------------------------------
bash -c 'exec -a "python x_reader.py sync" sleep 6' & sleeper=$!
sleep 0.5
out="$("$T/helper.sh" sync)"
kill "$sleeper" 2>/dev/null; wait "$sleeper" 2>/dev/null
check "a second sync is refused while one runs" "$(has "$out" 'already running')"

echo
if [ "$fail" = 0 ]; then echo "✓ app helper verified"; else echo "✗ $fail check(s) failed"; exit 1; fi
