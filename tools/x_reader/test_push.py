#!/usr/bin/env python3
"""
The Trendwire bridge in x_reader.py, against a local stub. No network, no X.

    python3 tools/x_reader/test_push.py

Each case is a way the bridge could become a nuisance rather than a feature:
dumping an old archive into one issue, hammering a dead tweet every day,
hiding a wrong secret, or breaking sync when Trendwire is down.
"""
import importlib.util
import json
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("xr", HERE / "x_reader.py")
xr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(xr)
xr.time.sleep = lambda _s: None          # the real pause is for politeness, not for tests

failed = 0


def check(label: str, ok: bool) -> None:
    global failed
    print(f"  {'✓' if ok else '✗'} {label}")
    failed += 0 if ok else 1


# ---- a stub Trendwire --------------------------------------------------------
seen: list[dict] = []
behave = {"default": 200, "by_id": {}}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        seen.append({"path": self.path, "auth": self.headers.get("authorization"), "body": body})
        tid = body.get("url", "").rsplit("/", 1)[-1]
        code = behave["by_id"].get(tid, behave["default"])
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"ok": code == 200}).encode())


server = HTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{server.server_address[1]}"


def fresh(n_old: int = 0, n_new: int = 0):
    """A clean data dir, with n_old items present before push is enabled."""
    tmp = Path(tempfile.mkdtemp())
    xr.DATA, xr.ITEMS, xr.PUSH_STATE = tmp, tmp / "items", tmp / "push_state.json"
    xr.ITEMS.mkdir(parents=True)
    seen.clear()
    behave["default"], behave["by_id"] = 200, {}
    xr.TRENDWIRE_URL, xr.TRENDWIRE_SECRET, xr.TRENDWIRE_PUSH_LIMIT = URL, "s3cret", 15
    add(n_old, 0)
    return n_new


def add(n: int, start: int) -> None:
    for i in range(start, start + n):
        item = {"id": str(1000 + i), "order": float(i), "handle": "someone",
                "tweet_url": f"https://x.com/someone/status/{1000 + i}"}
        (xr.ITEMS / f"{item['id']}.json").write_text(json.dumps(item))


def state() -> dict:
    return xr._push_state()


# 1. off by default ------------------------------------------------------------
fresh(3)
xr.TRENDWIRE_URL = ""
xr.push_baseline()
r = xr.push_items()
check("nothing is sent when TRENDWIRE_URL is unset", not seen and r["sent"] == 0)
check("no state file is written when it is off", not xr.PUSH_STATE.exists())

# 2. baseline ------------------------------------------------------------------
fresh(5)
xr.push_baseline()
check("the first run records existing bookmarks as sent", len(state()["pushed"]) == 5)
r = xr.push_items()
check("an existing archive is not sent", not seen and r["sent"] == 0)
add(2, 100)
r = xr.push_items()
check("a bookmark that arrives after the baseline is sent", r["sent"] == 2 and len(seen) == 2)
r = xr.push_items()
check("it is not sent twice", r["sent"] == 0 and len(seen) == 2)

# 3. request shape ---------------------------------------------------------------
check("it posts to /api/bookmark", seen[0]["path"] == "/api/bookmark")
check("it sends the secret as a bearer token", seen[0]["auth"] == "Bearer s3cret")
check("the body is the tweet URL", seen[0]["body"]["url"].startswith("https://x.com/someone/status/"))
check("newest first", seen[0]["body"]["url"].endswith("1101"))

# 4. cap -------------------------------------------------------------------------
fresh()
xr.push_baseline()
add(20, 0)
r = xr.push_items()
check("a run sends at most the cap", r["sent"] == 15 and len(seen) == 15)
check("the rest are reported as waiting", r["waiting"] == 5)
r = xr.push_items()
check("the next run sends the remainder", r["sent"] == 5)
fresh()
xr.push_baseline()
add(9, 0)
r = xr.push_items(limit=4)
check("--limit overrides the cap", r["sent"] == 4)

# 5. wrong secret ---------------------------------------------------------------
fresh()
xr.push_baseline()
add(4, 0)
behave["default"] = 401
r = xr.push_items()
check("a rejected secret stops at the first request", len(seen) == 1)
check("and says why", "secret" in r["stopped"].lower())
check("nothing is marked sent", state()["pushed"] == [] and state()["skipped"] == [])
fresh()
xr.TRENDWIRE_SECRET = ""
r = xr.push_items()
check("a missing secret stops before any request", not seen and "SECRET" in r["stopped"])

# 6. a tweet Trendwire cannot read ---------------------------------------------------
fresh()
xr.push_baseline()
add(3, 0)
behave["by_id"] = {"1001": 400}
r = xr.push_items()
check("a 400 is given up on, the rest still go", r["skipped"] == 1 and r["sent"] == 2)
n = len(seen)
xr.push_items()
check("a given-up bookmark is not retried", len(seen) == n)

# 7. a tweet that keeps failing ---------------------------------------------------------
fresh()
xr.push_baseline()
add(1, 0)
behave["default"] = 502
for run in (1, 2):
    r = xr.push_items()
    check(f"a 502 is retried (run {run})", r["failed"] == 1 and state()["skipped"] == [])
r = xr.push_items()
check("after three failures it is given up on", state()["skipped"] == ["1000"] and r["skipped"] == 1)
n = len(seen)
xr.push_items()
check("and the cap is not spent on it again", len(seen) == n)

# 8. Trendwire is down ---------------------------------------------------------------------
fresh()
xr.push_baseline()
add(3, 0)
xr.TRENDWIRE_URL = "http://127.0.0.1:9"   # nothing listens here
r = xr.push_items()
check("an unreachable server stops the run, without raising", "unreachable" in r["stopped"])
check("nothing is lost", state()["pushed"] == [] and state()["skipped"] == [])
args = type("A", (), {"no_push": False})()
try:
    xr._push_hook(args)
    ok = True
except Exception:
    ok = False
check("the sync hook never raises", ok)

# 9. dry run and opt-out ---------------------------------------------------------------------
fresh()
xr.push_baseline()
add(3, 0)
r = xr.push_items(dry_run=True)
check("--dry-run sends nothing", not seen and r["sent"] == 3)
check("--dry-run records nothing", state()["pushed"] == [])
xr._push_hook(type("A", (), {"no_push": True})())
check("--no-push sends nothing", not seen)

server.shutdown()
print("\n✓ x_reader push verified\n" if failed == 0 else f"\n✗ {failed} check(s) failed\n")
sys.exit(1 if failed else 0)
