#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "httpx>=0.27",
#   "playwright>=1.45",
#   "trafilatura>=1.12",
#   "pypdf>=4.0",
#   "python-dotenv>=1.0",
#   "vaderSentiment>=3.3",   # optional: better tone scores; a built-in word list is the fallback
# ]
# ///
"""
x_reader.py : X bookmarks -> PDFs + summaries -> private e-ink reading site.
Zero-cost version: no X API, no paid LLM.

HOW IT GETS BOOKMARKS
  A headless Chromium opens x.com/i/bookmarks with YOUR signed-in session,
  scrolls, and reads the JSON that the X web app loads. No X API key.
  Risk: automated access is against X's terms. Keep runs small (one per day).

.env (all optional)
  X_AUTH_TOKEN=, X_CT0=     cookies from your normal browser (see `login` for the other way)
  SUMMARY_BACKEND=ollama    ollama | anthropic | none
  OLLAMA_URL=http://localhost:11434
  OLLAMA_MODEL=llama3.2
  ANTHROPIC_API_KEY=, ANTHROPIC_MODEL=claude-haiku-5-5
  SUMMARY_STYLE, SUMMARY_MAX_CHARS (24000), PDF_FORMAT (A5), SITE_TITLE, SITE_MOTTO
  CF_PAGES_PROJECT=my-x-reader
  CF_KV_NOTES_ID=...        Cloudflare KV namespace id for the notebook (free)
  AUTHOR_BIO, POST_STYLE    who you are and how you sound, for the angle desk
  WATCH_TOPICS=AI agents, AI liability     topics to track (else picked from what you save)
  VIBE_WEEKS=12             how many weeks of mood and numbers to track
  VIBES_EXTERNAL=gdelt,hn   free outside sources: GDELT news tone + volume, Hacker News; empty = only your feed
  TRENDWIRE_URL=https://duckfeet.vercel.app     send new bookmarks to a Trendwire deployment (off when empty)
  TRENDWIRE_BOOKMARK_SECRET=                    its BOOKMARK_SECRET (or CRON_SECRET) value
  TRENDWIRE_PUSH_LIMIT=15                       most bookmarks sent per run

COMMANDS
  login                      open a visible browser, sign in to X once
  sync [--limit N] [--full]  get new bookmarks, process them, build site/
  build                      rebuild site/ from stored items
  weekly|angles [--days N] [--deploy]
                             find links in your notes + reading, pitch angles; you write the posts
  pull-notes                 copy notebook entries from Cloudflare to xreader_data/ + LEARNINGS.md
  push [--limit N] [--backfill N] [--dry-run]
                             send bookmarks not yet sent to Trendwire (also runs after sync)
  deploy                     upload site/ to Cloudflare Pages (free)
  run  [--limit N] [--full]  sync + deploy
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import random
import re
import subprocess
import sys
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

DATA = ROOT / "xreader_data"
ITEMS = DATA / "items"
STATE = DATA / "state.json"
PROFILE = DATA / "browser_profile"
SITE = ROOT / "site"
NOTES_FILE = DATA / "notes.json"          # local copy of your notebook (from `pull-notes`)
EDITIONS = DATA / "editions"             # editor's notes, one JSON per edition

SUMMARY_BACKEND = os.getenv("SUMMARY_BACKEND", "ollama").lower()
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434").rstrip("/")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llama3.2")
ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-haiku-5-5")
SUMMARY_STYLE = os.getenv("SUMMARY_STYLE", "ASD-STE100 Simplified Technical English")
SUMMARY_MAX_CHARS = int(os.getenv("SUMMARY_MAX_CHARS", "24000"))
PDF_FORMAT = os.getenv("PDF_FORMAT", "A5")
SITE_TITLE = os.getenv("SITE_TITLE", "Your Digest")
SITE_MOTTO = os.getenv("SITE_MOTTO", "All the bookmarks fit to read")
CF_PROJECT = os.getenv("CF_PAGES_PROJECT", "")
CF_KV_NOTES_ID = os.getenv("CF_KV_NOTES_ID", "")
WEEKLY = DATA / "weekly"
VIBES = DATA / "vibes"
VIBE_WEEKS = int(os.getenv("VIBE_WEEKS", "12"))
WATCH_TOPICS = [t.strip() for t in os.getenv("WATCH_TOPICS", "").split(",") if t.strip()]
VIBES_EXTERNAL = {x.strip().lower() for x in os.getenv("VIBES_EXTERNAL", "gdelt,hn").split(",") if x.strip()}
AUTHOR_BIO = os.getenv("AUTHOR_BIO", "a product leader who reads a lot")
POST_STYLE = os.getenv("POST_STYLE", "plain spoken English, short sentences, dry humor, no em dashes, no buzzwords, no hype, no emojis unless one makes the joke land")

X_HOSTS = {"x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com",
           "mobile.twitter.com", "t.co"}
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0 Safari/537.36")


# ---------- helpers ----------

def die(msg: str):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def load_json(p: Path, default):
    return json.loads(p.read_text()) if p.exists() else default


def save_json(p: Path, obj) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, indent=2, ensure_ascii=False))
    tmp.replace(p)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def esc(s) -> str:
    return html.escape(str(s or ""))


# ---------- X session (browser, no API) ----------

def _x_context(pw, headless: bool):
    PROFILE.mkdir(parents=True, exist_ok=True)
    ctx = pw.chromium.launch_persistent_context(
        str(PROFILE), headless=headless, user_agent=UA,
        viewport={"width": 1200, "height": 1600})
    auth, ct0 = os.getenv("X_AUTH_TOKEN"), os.getenv("X_CT0")
    if auth and ct0:
        ctx.add_cookies([
            {"name": "auth_token", "value": auth, "domain": ".x.com", "path": "/",
             "secure": True, "httpOnly": True, "sameSite": "None"},
            {"name": "ct0", "value": ct0, "domain": ".x.com", "path": "/",
             "secure": True, "sameSite": "Lax"},
        ])
    return ctx


def _ensure_chromium(pw):
    if not Path(pw.chromium.executable_path).exists():
        subprocess.run([sys.executable, "-m", "playwright", "install", "chromium"], check=True)


def cmd_login(_args) -> None:
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        _ensure_chromium(pw)
        ctx = _x_context(pw, headless=False)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto("https://x.com/login")
        input("Sign in to X in the browser window. Then press Enter here. ")
        ctx.close()
    print(f"Session saved in {PROFILE}")


# ---------- parse the X web app's GraphQL JSON into the v2-like shape process() uses ----------

def _tweet_results(node):
    """Yield every timeline tweet result in a GraphQL payload."""
    if isinstance(node, dict):
        ic = node.get("itemContent")
        if isinstance(ic, dict) and isinstance(ic.get("tweet_results"), dict):
            r = ic["tweet_results"].get("result")
            if r:
                yield r
        for v in node.values():
            yield from _tweet_results(v)
    elif isinstance(node, list):
        for v in node:
            yield from _tweet_results(v)


def _unwrap(r: dict | None) -> dict | None:
    if r and r.get("__typename") == "TweetWithVisibilityResults":
        return r.get("tweet")
    return r


def _iso(s: str | None) -> str | None:
    if not s:
        return None
    try:
        return datetime.strptime(s, "%a %b %d %H:%M:%S %z %Y").isoformat()
    except ValueError:
        return s


def _to_v2(r: dict, users: dict, media: dict, refs: dict) -> dict | None:
    r = _unwrap(r)
    if not r or "legacy" not in r:
        return None
    lg = r["legacy"]
    tid = r.get("rest_id") or lg.get("id_str")
    ur = ((r.get("core") or {}).get("user_results") or {}).get("result") or {}
    ucore, ulg = ur.get("core") or {}, ur.get("legacy") or {}
    uid = ur.get("rest_id") or lg.get("user_id_str") or "0"
    users[uid] = {"id": uid,
                  "username": ucore.get("screen_name") or ulg.get("screen_name") or "i",
                  "name": ucore.get("name") or ulg.get("name") or ""}

    ents = lg.get("entities") or {}
    urls = [{"url": u.get("url"), "expanded_url": u.get("expanded_url")}
            for u in ents.get("urls", [])]
    keys = []
    for m in (lg.get("extended_entities") or ents).get("media", []) or []:
        k = m.get("id_str") or m.get("media_key")
        if not k:
            continue
        keys.append(k)
        media[k] = {"media_key": k, "type": m.get("type"),
                    "url": m.get("media_url_https"), "alt_text": m.get("ext_alt_text") or ""}
        if m.get("url"):
            urls.append({"url": m["url"], "media_key": k})

    t = {"id": tid, "text": lg.get("full_text", ""), "created_at": _iso(lg.get("created_at")),
         "author_id": uid, "entities": {"urls": urls},
         "attachments": {"media_keys": keys} if keys else {}}

    nt = ((r.get("note_tweet") or {}).get("note_tweet_results") or {}).get("result") or {}
    if nt.get("text"):
        nurls = [{"url": u.get("url"), "expanded_url": u.get("expanded_url")}
                 for u in (nt.get("entity_set") or {}).get("urls", [])]
        t["note_tweet"] = {"text": nt["text"],
                           "entities": {"urls": nurls + [u for u in urls if u.get("media_key")]}}

    art = ((r.get("article") or {}).get("article_results") or {}).get("result") or {}
    if art:
        t["article"] = {"title": art.get("title"),
                        "plain_text": art.get("plain_text") or art.get("preview_text")}

    q = (r.get("quoted_status_result") or {}).get("result")
    if q:
        qt = _to_v2(q, users, media, refs)
        if qt:
            refs[qt["id"]] = qt
            t["referenced_tweets"] = [{"type": "quoted", "id": qt["id"]}]
    return t


def fetch_bookmarks(done: set, full: bool, limit: int | None) -> list:
    from playwright.sync_api import sync_playwright
    users, media, refs = {}, {}, {}
    found: dict[str, dict] = {}
    order: list[str] = []

    def on_response(resp):
        if "/graphql/" not in resp.url or "Bookmarks" not in resp.url:
            return
        try:
            data = resp.json()
        except Exception:
            return
        for r in _tweet_results(data):
            t = _to_v2(r, users, media, refs)
            if t and t["id"] not in found:
                found[t["id"]] = t
                order.append(t["id"])

    with sync_playwright() as pw:
        _ensure_chromium(pw)
        ctx = _x_context(pw, headless=True)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.on("response", on_response)
        page.goto("https://x.com/i/bookmarks", wait_until="domcontentloaded", timeout=60_000)
        page.wait_for_timeout(4000)
        if "/login" in page.url or "/i/flow" in page.url:
            ctx.close()
            die("not signed in to X. Run: login  (or set X_AUTH_TOKEN and X_CT0)")
        idle, last = 0, -1
        while idle < 4:
            new = [i for i in order if i not in done]
            if not full and len(new) < len(order):
                break  # reached a bookmark we already have
            if limit and len(new) >= limit:
                break
            idle = idle + 1 if len(order) == last else 0
            last = len(order)
            page.mouse.wheel(0, 3500)
            page.wait_for_timeout(random.randint(1800, 3500))  # slow and gentle
        ctx.close()

    shared = {"users": users, "media": media, "refs": refs}
    todo = [(found[i], shared) for i in order if i not in done]
    return todo[:limit] if limit else todo


def tweet_text(t: dict) -> tuple[str, dict]:
    nt = t.get("note_tweet") or {}
    text = nt.get("text") or t.get("text", "")
    ents = nt.get("entities") or t.get("entities") or {}
    for u in ents.get("urls", []):
        short = u.get("url", "")
        if not short:
            continue
        full = "" if u.get("media_key") else (u.get("expanded_url") or short)
        text = text.replace(short, full)
    return html.unescape(text).strip(), ents


def outside_links(ents: dict) -> list[str]:
    links = []
    for u in ents.get("urls", []):
        if u.get("media_key"):
            continue
        link = u.get("unwound_url") or u.get("expanded_url") or ""
        host = (urllib.parse.urlparse(link).hostname or "").lower()
        if link and host not in X_HOSTS and link not in links:
            links.append(link)
    return links


# ---------- link -> PDF + text ----------

READER_CSS = """
@page { margin: 14mm 12mm; }
body { font: 12.5pt/1.55 Georgia, 'Iowan Old Style', serif; color: #000; }
h1 { font-size: 18pt; line-height: 1.25; margin: 0 0 4pt; }
.src { font: 9pt/1.4 Helvetica, Arial, sans-serif; margin-bottom: 14pt;
       border-bottom: 1px solid #000; padding-bottom: 6pt; word-break: break-all; }
p { margin: 0 0 9pt; text-align: left; }
"""


def _reader_html(title: str, url: str, byline: str, text: str) -> str:
    paras = "".join(f"<p>{esc(p)}</p>" for p in text.split("\n") if p.strip())
    return (f"<!doctype html><html><head><meta charset='utf-8'><style>{READER_CSS}</style>"
            f"</head><body><h1>{esc(title)}</h1><div class='src'>{esc(byline)}<br>{esc(url)}"
            f"</div>{paras}</body></html>")


def _save_remote_pdf(url: str, out: Path) -> tuple[str, str]:
    from pypdf import PdfReader
    r = httpx.get(url, follow_redirects=True, timeout=60, headers={"User-Agent": UA})
    r.raise_for_status()
    out.write_bytes(r.content)
    reader = PdfReader(str(out))
    title = (reader.metadata.title if reader.metadata else None) or Path(urllib.parse.urlparse(url).path).name
    text = "\n".join((pg.extract_text() or "") for pg in reader.pages[:40])
    return title, text


def render_link(browser, url: str, tid: str) -> tuple[str, str, str]:
    """Return (title, body_text, pdf_filename)."""
    import trafilatura
    pdf_dir = SITE / "pdf"
    pdf_dir.mkdir(parents=True, exist_ok=True)
    name = f"{tid}.pdf"
    out = pdf_dir / name

    if urllib.parse.urlparse(url).path.lower().endswith(".pdf"):
        title, text = _save_remote_pdf(url, out)
        return title, text, name

    ctx = browser.new_context(user_agent=UA, viewport={"width": 1000, "height": 1400})
    page = ctx.new_page()
    try:
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=45_000)
        except Exception as e:
            if "Download" in str(e):
                title, text = _save_remote_pdf(url, out)
                return title, text, name
            raise
        try:
            page.wait_for_load_state("networkidle", timeout=10_000)
        except Exception:
            pass
        final_url, raw = page.url, page.content()
        meta = trafilatura.extract_metadata(raw, default_url=final_url)
        title = (meta.title if meta and meta.title else None) or page.title() or final_url
        byline = " · ".join(x for x in [
            meta.author if meta else None, meta.sitename if meta else None,
            meta.date if meta else None] if x)
        text = trafilatura.extract(raw, url=final_url, include_comments=False,
                                   include_tables=True, favor_recall=True) or ""
        if len(text) >= 800:
            page.set_content(_reader_html(title, final_url, byline, text), wait_until="load")
            page.emulate_media(media="print")
        else:
            page.emulate_media(media="screen")
        page.pdf(path=str(out), format=PDF_FORMAT, print_background=False,
                 margin={"top": "12mm", "bottom": "12mm", "left": "10mm", "right": "10mm"})
        return title, text, name
    finally:
        ctx.close()


# ---------- summary (local by default) ----------

def make_llm():
    """Return a function prompt -> text, or None."""
    if SUMMARY_BACKEND == "none":
        return None
    if SUMMARY_BACKEND == "anthropic":
        if not os.getenv("ANTHROPIC_API_KEY"):
            print("  ANTHROPIC_API_KEY not set: no summaries")
            return None
        import anthropic
        client = anthropic.Anthropic()

        def call(prompt: str) -> str:
            msg = client.messages.create(model=ANTHROPIC_MODEL, max_tokens=800,
                                         messages=[{"role": "user", "content": prompt}])
            return "".join(b.text for b in msg.content if b.type == "text")
        return call

    try:
        httpx.get(f"{OLLAMA_URL}/api/tags", timeout=3).raise_for_status()
    except Exception:
        print(f"  Ollama not reachable at {OLLAMA_URL}: no summaries")
        return None

    def call(prompt: str) -> str:
        r = httpx.post(f"{OLLAMA_URL}/api/chat", timeout=600, json={
            "model": OLLAMA_MODEL, "stream": False,
            "messages": [{"role": "user", "content": prompt}]})
        r.raise_for_status()
        return r.json()["message"]["content"]
    return call


def summarize(llm, title: str, body: str, tweet: str) -> str:
    prompt = (
        f"Summarize this for a busy reader. Write in {SUMMARY_STYLE}.\n"
        "Format, plain text only:\n"
        "Line 1: one sentence with the main point.\n"
        "Then 3 to 6 lines that start with '- ', one fact or claim each. Keep numbers and names.\n"
        "Last line: 'Why it matters: ' plus one sentence.\n\n"
        f"Tweet that shared it:\n{tweet[:1500]}\n\nTitle: {title}\n\n"
        f"Text:\n{body[:SUMMARY_MAX_CHARS]}"
    )
    out = llm(prompt)
    return re.sub(r"<think>.*?</think>", "", out, flags=re.S).strip()


# ---------- process one bookmark ----------

def process(t: dict, ctx: dict, browser, llm, order: float) -> dict:
    users, media, refs = ctx["users"], ctx["media"], ctx["refs"]
    author = users.get(t.get("author_id"), {})
    handle = author.get("username", "i")
    text, ents = tweet_text(t)
    item = {
        "id": t["id"], "order": order, "created_at": t.get("created_at"),
        "saved_at": now_iso(), "author": author.get("name", handle), "handle": handle,
        "tweet_url": f"https://x.com/{handle}/status/{t['id']}", "text": text,
        "kind": "tweet", "images": [], "quoted": None,
    }
    for key in (t.get("attachments") or {}).get("media_keys", []):
        m = media.get(key) or {}
        src = m.get("url") or m.get("preview_image_url")
        if src:
            item["images"].append({"src": src, "alt": m.get("alt_text", ""), "type": m.get("type")})
    for ref in t.get("referenced_tweets", []) or []:
        q = refs.get(ref["id"])
        if ref.get("type") == "quoted" and q:
            qa = users.get(q.get("author_id"), {})
            qtext, _ = tweet_text(q)
            item["quoted"] = {"handle": qa.get("username", "i"), "name": qa.get("name", ""),
                              "text": qtext,
                              "url": f"https://x.com/{qa.get('username', 'i')}/status/{q['id']}"}

    links = outside_links(ents)
    article = t.get("article") or {}
    try:
        if links:
            item.update(kind="link", url=links[0], other_links=links[1:])
            title, body, pdf = render_link(browser, links[0], t["id"])
            item.update(title=title, pdf=f"pdf/{pdf}")
            if len(body) > 300 and llm:
                item["summary"] = summarize(llm, title, body, text)
        elif article.get("title") or article.get("plain_text"):
            body = article.get("plain_text") or ""
            item.update(kind="article", title=article.get("title") or "X Article", article_text=body)
            if len(body) > 300 and llm:
                item["summary"] = summarize(llm, item["title"], body, text)
    except Exception as e:
        item["error"] = f"{type(e).__name__}: {e}"[:400]
    return item


def cmd_sync(args) -> None:
    state = load_json(STATE, {"done": []})
    done = set(state.get("done", []))
    if not getattr(args, "no_push", False):
        push_baseline()   # before this run adds anything, so only *new* ones are sent
    notes = pull_notes()
    todo = fetch_bookmarks(done, args.full, args.limit)
    print(f"{len(todo)} new bookmark(s)")
    if not todo:
        _push_hook(args)  # still retries anything that failed last time
        build_site()
        return

    edition = datetime.now().date().isoformat()  # one edition per day
    llm = make_llm()
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        base = time.time()
        for i, (t, ctx) in enumerate(todo):
            item = process(t, ctx, browser, llm, order=base - i * 0.001)
            item["edition"] = edition
            save_json(ITEMS / f"{t['id']}.json", item)
            flag = f"  ! {item['error']}" if item.get("error") else ""
            print(f"  [{i + 1}/{len(todo)}] {item['kind']:7} @{item['handle']}{flag}")
            if not item.get("error"):
                done.add(t["id"])
                state["done"] = sorted(done)
                save_json(STATE, state)
        browser.close()
    write_editor_note(edition, llm, notes)
    _push_hook(args)
    build_site()


# ---------- push to Trendwire (optional) ----------
#
# Trendwire keeps a "saved" desk: a tweet you bookmark gets a guaranteed seat in
# its next issue, with the links and images it carries. Its /api/bookmark takes
# a tweet URL and does its own fetching, so all this script supplies is the URL
# of each new bookmark. That is the one thing Trendwire's own bookmark path
# otherwise needs a paid X API token for (X_BOOKMARKS_TOKEN).
#
# Three rules keep it from being a nuisance:
#   * Off unless TRENDWIRE_URL is set. Nothing about sync changes without it.
#   * The first run records what already exists as "sent". Trendwire files a
#     bookmark under the day it arrives, so an old archive pushed in one go
#     would land entirely in one issue. `push --backfill N` is the explicit way.
#   * Capped per run, and a bookmark that keeps failing is given up on, so a
#     deleted tweet cannot use the cap up every day.

TRENDWIRE_URL = os.getenv("TRENDWIRE_URL", "").rstrip("/")
TRENDWIRE_SECRET = os.getenv("TRENDWIRE_BOOKMARK_SECRET", "")
TRENDWIRE_PUSH_LIMIT = int(os.getenv("TRENDWIRE_PUSH_LIMIT", "15"))
PUSH_STATE = DATA / "push_state.json"   # its own file: sync rewrites state.json wholesale
PUSH_MAX_ATTEMPTS = 3


def _push_state() -> dict:
    st = load_json(PUSH_STATE, {})
    st.setdefault("pushed", [])
    st.setdefault("skipped", [])
    st.setdefault("attempts", {})
    return st


def push_baseline() -> None:
    """First run with push on: everything already saved counts as sent."""
    if not TRENDWIRE_URL or PUSH_STATE.exists():
        return
    ids = sorted(p.stem for p in ITEMS.glob("*.json")) if ITEMS.exists() else []
    save_json(PUSH_STATE, {"pushed": ids, "skipped": [], "attempts": {},
                           "baseline": len(ids), "since": now_iso()})
    if ids:
        print(f"trendwire: {len(ids)} existing bookmark(s) marked as already sent "
              f"(`push --backfill N` sends the newest N)")


def push_items(limit: int | None = None, backfill: int | None = None,
               dry_run: bool = False) -> dict:
    """Send bookmarks Trendwire has not seen, newest first. Never raises on a bad reply."""
    out = {"sent": 0, "failed": 0, "skipped": 0, "waiting": 0, "stopped": ""}
    if not TRENDWIRE_URL:
        return out
    if not TRENDWIRE_SECRET and not dry_run:
        out["stopped"] = "TRENDWIRE_BOOKMARK_SECRET is not set"
        print(f"trendwire: {out['stopped']}")
        return out

    st = _push_state()
    sent, skipped = set(st["pushed"]), set(st["skipped"])
    pending = [it for it in _load_items()
               if it.get("id") and it.get("tweet_url")
               and it["id"] not in sent and it["id"] not in skipped]
    cap = backfill if backfill is not None else (limit or TRENDWIRE_PUSH_LIMIT)
    todo, out["waiting"] = pending[:cap], max(0, len(pending) - cap)

    if dry_run:
        for it in todo:
            print(f"  would send @{it.get('handle', '?')}: {it['tweet_url']}")
        out["sent"] = len(todo)
        return out

    endpoint = f"{TRENDWIRE_URL}/api/bookmark"
    headers = {"authorization": f"Bearer {TRENDWIRE_SECRET}", "user-agent": "x_reader/1"}
    for it in todo:
        tid = it["id"]
        try:
            r = httpx.post(endpoint, json={"url": it["tweet_url"]}, headers=headers, timeout=45)
        except httpx.HTTPError as e:
            out["stopped"] = f"Trendwire unreachable ({type(e).__name__}); will retry next run"
            break
        if r.status_code == 200:
            sent.add(tid)
            out["sent"] += 1
        elif r.status_code in (401, 403):
            out["stopped"] = "Trendwire rejected the secret (check TRENDWIRE_BOOKMARK_SECRET)"
            break
        elif r.status_code == 400:
            skipped.add(tid)            # not a tweet it can read; retrying cannot help
            out["skipped"] += 1
        else:
            n = st["attempts"].get(tid, 0) + 1
            st["attempts"][tid] = n
            if n >= PUSH_MAX_ATTEMPTS:  # a deleted or protected tweet
                skipped.add(tid)
                out["skipped"] += 1
            else:
                out["failed"] += 1
        st["pushed"], st["skipped"] = sorted(sent), sorted(skipped)
        save_json(PUSH_STATE, st)
        time.sleep(0.4)                 # gentle on a free-tier function

    st["pushed"], st["skipped"] = sorted(sent), sorted(skipped)
    save_json(PUSH_STATE, st)
    if out["stopped"]:
        print(f"trendwire: {out['stopped']}")
    print(f"trendwire: sent {out['sent']}, failed {out['failed']}, "
          f"given up {out['skipped']}, {out['waiting']} waiting")
    return out


def _push_hook(args) -> None:
    """Called at the end of sync. A push problem must never break a sync."""
    if not TRENDWIRE_URL or getattr(args, "no_push", False):
        return
    try:
        push_items()
    except Exception as e:  # noqa: BLE001
        print(f"  ! trendwire push skipped: {type(e).__name__}: {e}")


def cmd_push(args) -> None:
    if not TRENDWIRE_URL:
        die("set TRENDWIRE_URL (and TRENDWIRE_BOOKMARK_SECRET) in .env")
    push_baseline()
    push_items(limit=args.limit, backfill=args.backfill, dry_run=args.dry_run)


# ---------- editions + editor's note ----------

def _edition_of(it: dict) -> str:
    return it.get("edition") or (it.get("saved_at") or now_iso())[:10]


def _load_items() -> list[dict]:
    items = [load_json(p, {}) for p in ITEMS.glob("*.json")] if ITEMS.exists() else []
    for it in items:
        it["edition"] = _edition_of(it)
    items.sort(key=lambda i: i.get("order", 0), reverse=True)
    return items


def _parse_summary(s: str | None) -> tuple[str, list[str], str]:
    """Split a summary into (dek, bullets, why_it_matters)."""
    dek, bullets, why = "", [], ""
    for line in (s or "").splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith(("- ", "* ", "• ")):
            bullets.append(line[2:].strip())
        elif line.lower().startswith("why it matters"):
            why = line.split(":", 1)[-1].strip()
        elif not dek:
            dek = line
        else:
            bullets.append(line)
    return dek, bullets, why


def write_editor_note(edition: str, llm, notes: dict) -> None:
    """A short note that links the day's stories to what you logged before."""
    if not llm:
        return
    items = [it for it in _load_items() if it["edition"] == edition]
    if not items:
        return
    stories = "\n".join(
        f"- {_headline(it)}: {(_parse_summary(it.get('summary'))[0] or it.get('text', ''))[:300]}"
        for it in items[:25])
    past = [n["text"] for ed in sorted(notes, reverse=True) if ed < edition for n in notes[ed]][:12]
    past_txt = "\n".join(f"- {p[:300]}" for p in past) or "(none yet)"
    prompt = (
        "You edit a small personal newspaper made from the reader's saved posts.\n"
        f"Write in {SUMMARY_STYLE}. Output exactly two lines:\n"
        "NOTE: 2 or 3 sentences that connect today's stories. If a story supports or "
        "goes against one of the reader's earlier notes, say which one.\n"
        "QUESTION: one open question for the reader to think about today.\n\n"
        f"Today's stories:\n{stories}\n\nThe reader's earlier notes:\n{past_txt}")
    try:
        out = re.sub(r"<think>.*?</think>", "", llm(prompt), flags=re.S)
    except Exception as e:
        print(f"  editor's note failed: {e}")
        return
    note = question = ""
    for line in out.splitlines():
        if line.strip().upper().startswith("NOTE:"):
            note = line.split(":", 1)[1].strip()
        elif line.strip().upper().startswith("QUESTION:"):
            question = line.split(":", 1)[1].strip()
    if note or question:
        save_json(EDITIONS / f"{edition}.json", {"note": note, "question": question})


# ---------- notebook storage (Cloudflare KV, free tier) ----------

def _wrangler_kv(*args: str) -> str:
    cmd = ["npx", "--yes", "wrangler", "kv", "key", *args,
           "--namespace-id", CF_KV_NOTES_ID, "--remote"]
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, check=True).stdout


def _json_from(out: str):
    i = out.find("[")  # skip any wrangler banner text
    return json.loads(out[i:]) if i >= 0 else []


def pull_notes() -> dict:
    """Copy notebook entries from Cloudflare KV to xreader_data/notes.json and LEARNINGS.md."""
    if not CF_KV_NOTES_ID:
        return load_json(NOTES_FILE, {})
    try:
        out = {}
        for k in _json_from(_wrangler_kv("list", "--prefix", "notes:")):
            out[k["name"][len("notes:"):]] = _json_from(_wrangler_kv("get", k["name"]))
    except Exception as e:
        print(f"  could not pull notebook: {e}")
        return load_json(NOTES_FILE, {})
    save_json(NOTES_FILE, out)
    md = ["# Learnings\n"]
    for ed in sorted(out, reverse=True):
        if out[ed]:
            md.append(f"\n## {_long_date(ed)}\n")
            for n in out[ed]:
                ref = f" _(re: {n['itemTitle']})_" if n.get("itemTitle") else ""
                md.append(f"- **{NOTE_KINDS.get(n.get('kind'), 'Note')}**: {n.get('text', '')}{ref}\n")
    (ROOT / "LEARNINGS.md").write_text("".join(md))
    return out


def cmd_pull_notes(_args) -> None:
    if not CF_KV_NOTES_ID:
        die("set CF_KV_NOTES_ID in .env")
    notes = pull_notes()
    print(f"{sum(len(v) for v in notes.values())} notebook entries -> {NOTES_FILE} and LEARNINGS.md")


# ---------- static site: a small daily newspaper ----------

NOTE_KINDS = {"learned": "Learnt", "changed": "Changed my mind", "odd": "Odd or funny",
              "question": "Open question", "todo": "To act on"}

FONTS = ("<link rel='preconnect' href='https://fonts.googleapis.com'>"
         "<link rel='preconnect' href='https://fonts.gstatic.com' crossorigin>"
         "<link rel='stylesheet' href='https://fonts.googleapis.com/css2?"
         "family=Libre+Franklin:wght@500;600;700;800"
         "&family=Playfair+Display:ital,wght@0,700;0,900;1,700"
         "&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400"
         "&display=swap'>")

SITE_CSS = """
:root { color-scheme: light; --ink: #000; --soft: #3a3a3a; --paper: #fff;
  --serif: "Source Serif 4", Georgia, "Times New Roman", serif;
  --display: "Playfair Display", Georgia, serif;
  --sans: "Libre Franklin", "Helvetica Neue", Arial, sans-serif; }
* { box-sizing: border-box; animation: none !important; transition: none !important; }
html { background: var(--paper); color: var(--ink); -webkit-text-size-adjust: 100%; }
body { margin: 0; font: 19px/1.5 var(--serif); }
a { color: inherit; text-decoration-thickness: 1px; text-underline-offset: 3px; }
:focus-visible { outline: 3px solid var(--ink); outline-offset: 2px; }
.sans { font-family: var(--sans); }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.sheet { max-width: 1120px; margin: 0 auto; padding: 14px 16px 72px; }

/* masthead */
.mast { text-align: center; }
.ears { display: flex; justify-content: space-between; gap: 12px; font: 600 11px/1.35 var(--sans);
  text-transform: uppercase; letter-spacing: .12em; }
.ears span { max-width: 34%; }
.ears span:last-child { text-align: right; }
.name { font: 900 clamp(46px, 11vw, 112px)/.9 var(--display); letter-spacing: -.02em; margin: .14em 0 .06em; }
.name a { text-decoration: none; }
.motto { font: italic 15px/1.3 var(--serif); margin: 0 0 10px; }
.dateline { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 4px 18px;
  border-top: 4px double var(--ink); border-bottom: 4px double var(--ink); padding: 7px 0;
  font: 700 12px/1.3 var(--sans); text-transform: uppercase; letter-spacing: .1em; }
.dateline a { text-decoration: none; }
.dateline a:hover { text-decoration: underline; }
.mini .name { font-size: clamp(34px, 6vw, 56px); line-height: 1.1; margin-bottom: .1em; }

/* editor's desk */
.desk { margin: 20px 0 4px; padding: 14px 18px; border: 1px solid var(--ink); display: grid; gap: 8px; }
.desk .label { font: 800 11px/1 var(--sans); text-transform: uppercase; letter-spacing: .16em; }
.desk p { margin: 0; }
.desk .note { font-style: italic; }
.desk .q { font-weight: 600; }

/* front page */
.front { display: grid; gap: 24px; padding: 22px 0 26px; border-bottom: 2px solid var(--ink); }
@media (min-width: 860px) { .front { grid-template-columns: 1.7fr 1fr; }
  .front aside { border-left: 1px solid var(--ink); padding-left: 24px; } }
.kicker { font: 800 12px/1.2 var(--sans); text-transform: uppercase; letter-spacing: .14em; margin-bottom: 8px; }
.lead h2 { font: 900 clamp(32px, 5.4vw, 58px)/1.02 var(--display); margin: 0 0 12px; letter-spacing: -.01em; }
.lead h2 a, .story h3 a { text-decoration: none; }
.lead h2 a:hover, .story h3 a:hover { text-decoration: underline; }
.dek { font-style: italic; font-size: 1.12em; line-height: 1.4; margin: 0 0 12px; }
.byline { font: 600 12px/1.4 var(--sans); text-transform: uppercase; letter-spacing: .08em; margin: 0 0 14px; color: var(--soft); }
.brief { margin: 0 0 12px; padding-left: 1.1em; }
.brief li { margin: .3em 0; }
.why { border-top: 1px solid var(--ink); border-bottom: 1px solid var(--ink); padding: 9px 0; margin: 14px 0; }
.why b { font: 800 11px/1 var(--sans); text-transform: uppercase; letter-spacing: .14em; margin-right: 8px; }
.links { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.btn { display: inline-flex; align-items: center; min-height: 44px; padding: 10px 14px; border: 1.5px solid var(--ink);
  background: var(--paper); color: var(--ink); font: 700 13px/1 var(--sans); text-transform: uppercase;
  letter-spacing: .08em; text-decoration: none; cursor: pointer; border-radius: 0; }
.btn.primary { background: var(--ink); color: var(--paper); }
.btn:disabled { opacity: .5; }
aside h4, .section-head { font: 800 12px/1 var(--sans); text-transform: uppercase; letter-spacing: .16em; }
aside h4 { margin: 0 0 10px; padding-bottom: 8px; border-bottom: 2px solid var(--ink); }
.inside { list-style: none; counter-reset: s; margin: 0 0 22px; padding: 0; }
.inside li { counter-increment: s; display: grid; grid-template-columns: 28px 1fr; padding: 8px 0; border-bottom: 1px dotted var(--ink); line-height: 1.3; }
.inside li::before { content: counter(s); font: 900 18px/1.1 var(--display); }
.inside a { text-decoration: none; }
.resurface { border-left: 4px solid var(--ink); padding: 4px 0 4px 14px; margin: 0; }
.resurface p { margin: 0 0 6px; font-style: italic; }
.resurface .byline { margin: 0; }

/* sections */
.section-head { display: flex; align-items: center; gap: 14px; margin: 34px 0 16px; }
.section-head::after { content: ""; flex: 1; border-top: 2px solid var(--ink); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); margin-left: -17px; clip-path: inset(0 0 0 2px); }
.story { border-left: 1px solid var(--ink); padding: 0 16px 22px; margin-bottom: 4px; }
.story h3 { font: 700 25px/1.12 var(--display); margin: 0 0 8px; }
.story .dek { font-size: 1em; }
.dispatches { columns: 300px; column-gap: 34px; column-rule: 1px solid var(--ink); }
.dispatch { break-inside: avoid; padding-bottom: 16px; margin-bottom: 16px; border-bottom: 1px solid var(--ink); }
.dispatch .who { font: 700 14px/1.3 var(--sans); margin-bottom: 4px; }
.dispatch .who span { font-weight: 500; color: var(--soft); }
.dispatch p { margin: 0 0 8px; white-space: pre-line; overflow-wrap: anywhere; }
.dispatch .more { font: 700 12px/1 var(--sans); text-transform: uppercase; letter-spacing: .08em; }
.quote { border-left: 3px solid var(--ink); padding-left: 12px; margin: 8px 0; font-size: .92em; }

/* notebook */
.notebook { margin-top: 40px; border: 2px solid var(--ink); padding: 18px; }
.nb-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.nb-head h2 { font: 900 32px/1 var(--display); margin: 0; }
.nb-head a { font: 700 12px/1 var(--sans); text-transform: uppercase; letter-spacing: .08em; }
.nb-sub { font-style: italic; margin: 6px 0 12px; }
.nb-list { list-style: none; margin: 0 0 16px; padding: 0; }
.nb-note { padding: 12px 0; border-top: 1px dotted var(--ink); }
.nb-kind { display: inline-block; font: 800 10px/1 var(--sans); text-transform: uppercase; letter-spacing: .12em;
  border: 1px solid var(--ink); padding: 4px 6px; margin-right: 10px; vertical-align: 2px; }
.nb-meta { display: block; margin-top: 4px; font: 500 13px/1.4 var(--sans); color: var(--soft); }
.nb-del { font: inherit; background: none; border: 0; padding: 0 0 0 6px; text-decoration: underline; cursor: pointer; color: inherit; }
.nb-empty { font-style: italic; color: var(--soft); padding: 8px 0; border-top: 1px dotted var(--ink); }
.chips { display: flex; flex-wrap: wrap; gap: 8px; border: 0; padding: 0; margin: 0 0 10px; }
.chips label, .chips button { position: relative; }
.chips input { position: absolute; opacity: 0; inset: 0; }
.chips span, .chips button { display: inline-flex; align-items: center; min-height: 40px; padding: 8px 12px;
  border: 1.5px solid var(--ink); font: 700 12px/1 var(--sans); text-transform: uppercase; letter-spacing: .06em;
  background: var(--paper); color: var(--ink); cursor: pointer; border-radius: 0; }
.chips input:checked + span, .chips button[aria-pressed="true"] { background: var(--ink); color: var(--paper); }
.chips input:focus-visible + span { outline: 3px solid var(--ink); outline-offset: 2px; }
textarea { display: block; width: 100%; min-height: 120px; padding: 12px; font: 19px/1.5 var(--serif);
  border: 1.5px solid var(--ink); border-radius: 0; background: var(--paper); color: var(--ink); resize: vertical; }
.nb-actions { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 10px; }
.nb-status { font: 500 13px/1.4 var(--sans); }
.nb-group h3 { font: 800 13px/1.2 var(--sans); text-transform: uppercase; letter-spacing: .1em; margin: 26px 0 6px; }

/* story page */
.article { max-width: 44rem; margin: 26px auto 0; }
.article h1 { font: 900 clamp(34px, 6vw, 60px)/1.02 var(--display); margin: 0 0 14px; letter-spacing: -.01em; }
.inbrief { border-top: 2px solid var(--ink); border-bottom: 1px solid var(--ink); padding: 12px 0; margin: 18px 0; }
.inbrief h4 { margin: 0 0 6px; font: 800 12px/1 var(--sans); text-transform: uppercase; letter-spacing: .16em; }
.pull { font: italic 700 clamp(22px, 3.4vw, 30px)/1.25 var(--display); margin: 22px 0; padding: 14px 0;
  border-top: 4px double var(--ink); border-bottom: 4px double var(--ink); }
.post { border: 1px solid var(--ink); padding: 14px 16px; margin: 20px 0; }
.post p { white-space: pre-line; overflow-wrap: anywhere; margin: 0; }
.body p:first-of-type::first-letter { float: left; font: 900 3.6em/.8 var(--display); padding: 6px 8px 0 0; }
img { max-width: 100%; height: auto; display: block; margin: 12px 0; filter: grayscale(1); }
.err { font: 14px/1.4 var(--sans); border: 1px dashed var(--ink); padding: 8px; }

/* archive + footer */
.archive { list-style: none; padding: 0; margin: 20px 0; }
.archive li { display: grid; grid-template-columns: 90px 1fr; gap: 12px; padding: 14px 0; border-bottom: 1px solid var(--ink); }
.archive .no { font: 900 26px/1 var(--display); }
.archive a { font: 700 22px/1.2 var(--display); text-decoration: none; }
.archive .sans { display: block; font-size: 13px; color: var(--soft); margin-top: 4px; }
.foot { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-top: 40px; padding-top: 14px;
  border-top: 4px double var(--ink); font: 700 12px/1.3 var(--sans); text-transform: uppercase; letter-spacing: .1em; }
.empty { text-align: center; font-style: italic; padding: 60px 0; }

/* week in review */
.stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); border-top: 2px solid var(--ink); border-bottom: 1px solid var(--ink); }
.stat { padding: 14px 12px 14px 0; border-bottom: 1px dotted var(--ink); }
.stat b { display: block; font: 900 46px/1 var(--display); }
.stat span { font: 800 11px/1.3 var(--sans); text-transform: uppercase; letter-spacing: .12em; }
.over { font-weight: 800; text-decoration: underline; }

/* angle desk */
.angles { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 22px; }
.angle { border: 1.5px solid var(--ink); padding: 16px 18px 18px; display: flex; flex-direction: column; }
.angle.picked { border-width: 4px; padding: 13px 15px 15px; }
.angle-top { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
.angle-top .byline { margin: 0; }
.angle h3 { font: 900 26px/1.1 var(--display); margin: 2px 0 10px; }
.angle h4, .vibe h4 { font: 800 11px/1 var(--sans); text-transform: uppercase; letter-spacing: .14em; margin: 14px 0 6px; }
.connection { margin: 0 0 10px; }
.turn { font: italic 700 20px/1.3 var(--display); margin: 0; padding: 10px 0; border-top: 4px double var(--ink); border-bottom: 4px double var(--ink); }
.material { list-style: none; margin: 0; padding: 0; }
.material li { padding: 7px 0; border-bottom: 1px dotted var(--ink); line-height: 1.4; }
.material .nb-meta { display: inline; margin-left: 6px; }
.detail, .avoid { font-size: .92em; margin: 12px 0 0; }
.detail b, .avoid b { font: 800 11px/1 var(--sans); text-transform: uppercase; letter-spacing: .14em; margin-right: 8px; }
.prompts { margin: 0; padding-left: 1.3em; }
.prompts li { margin: .3em 0; }
.angle .links { margin-top: auto; padding-top: 14px; }
.pad { display: grid; gap: 24px; border: 2px solid var(--ink); padding: 18px; }
@media (min-width: 900px) { .pad { grid-template-columns: 1fr 1.5fr; }
  .pad-side { border-right: 1px solid var(--ink); padding-right: 22px; position: sticky; top: 12px; align-self: start; } }
.pad-title { font: 900 26px/1.15 var(--display); margin: 4px 0 12px; }
.pad .turn { margin-bottom: 12px; }
.pad-main h2 { font: 900 26px/1 var(--display); margin: 0 0 10px; }
.pad textarea { min-height: 260px; }
.pad textarea.short { min-height: 130px; }
.posted { gap: 8px; }
.posted input { width: 18px; height: 18px; accent-color: #000; margin: 0; }
code { font: 15px/1 ui-monospace, Menlo, monospace; }

/* vibes */
.vibes { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 480px), 1fr)); gap: 22px; }
.vibe { border-top: 3px solid var(--ink); padding-top: 10px; }
.vibe h3 { font: 900 26px/1.1 var(--display); margin: 0; }
.chips.static span { cursor: default; min-height: 30px; padding: 6px 10px; font-size: 11px; }
.sparks { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 18px; margin: 10px 0; }
.spark { margin: 0; }
.spark figcaption { font: 700 11px/1.3 var(--sans); text-transform: uppercase; letter-spacing: .08em; display: flex; justify-content: space-between; gap: 6px; }
.spark svg { display: block; width: 100%; height: auto; overflow: visible; }
.spark polyline { fill: none; stroke: var(--ink); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.spark .zero { stroke: var(--ink); stroke-width: 1; stroke-dasharray: 2 3; }
.spark .last { fill: var(--ink); }
.spark .pt rect { fill: transparent; }
.spark .pt circle { fill: var(--paper); stroke: var(--ink); stroke-width: 2; opacity: 0; }
.spark .pt:hover circle, .spark .pt:focus circle { opacity: 1; }
.spark-none { font: italic 15px/46px var(--serif); color: var(--soft); border-bottom: 1px dotted var(--ink); }
details { margin-top: 8px; }
summary { cursor: pointer; min-height: 32px; }
.tablewrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font: 14px/1.3 var(--sans); }
th, td { text-align: right; padding: 5px 6px; border-bottom: 1px dotted var(--ink); white-space: nowrap; }
th:first-child, td:first-child { text-align: left; }
th { font-weight: 800; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
"""

NOTEBOOK_JS = r"""
(function () {
  "use strict";
  var API = "/api/notes";
  var KINDS = { learned: "Learnt", changed: "Changed my mind", odd: "Odd or funny", question: "Open question", todo: "To act on" };
  var PENDING = "xr_pending_notes";

  function store(key, val) {
    try {
      if (val === undefined) return JSON.parse(localStorage.getItem(key) || "null");
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) { return null; }
  }
  function h(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function when(iso) {
    var d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  function longDate(ed) {
    var d = new Date(ed + "T12:00:00");
    return isNaN(d) ? ed : d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  }
  function canSync() { return /^https?:$/.test(location.protocol); }
  function call(method, qs, body, path) {
    if (!canSync()) return Promise.reject(new Error("offline"));
    return fetch((path || API) + (qs || ""), {
      method: method, credentials: "same-origin", cache: "no-store",
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); });
  }
  function pending() { return store(PENDING) || []; }
  function flush() {
    var q = pending(), left = [];
    if (!q.length || !canSync()) return Promise.resolve();
    return q.reduce(function (p, n) {
      return p.then(function () { return call("POST", "", n).catch(function () { left.push(n); }); });
    }, Promise.resolve()).then(function () { store(PENDING, left); });
  }
  function seed(el) {
    try { return JSON.parse(el.querySelector(".nb-seed").textContent); } catch (e) { return null; }
  }
  function noteHTML(n, up, canDelete) {
    var meta = [when(n.at)];
    if (n.item) meta.push('re: <a href="' + up + "item/" + h(n.item) + '.html">' + h(n.itemTitle || "story") + "</a>");
    if (n.pending) meta.push("saved on this device only");
    var del = canDelete ? '<button type="button" class="nb-del" data-id="' + h(n.id || "") + '" data-at="' + h(n.at) + '">Remove</button>' : "";
    return '<li class="nb-note"><span class="nb-kind">' + h(KINDS[n.kind] || "Note") + "</span>" + h(n.text) +
      '<span class="nb-meta">' + meta.join(" · ") + " " + del + "</span></li>";
  }

  // Notebook box on an edition page or a story page.
  function initBox(box) {
    var ed = box.dataset.edition, item = box.dataset.item || null, title = box.dataset.itemTitle || null;
    var up = box.dataset.up || "";
    var list = box.querySelector(".nb-list"), form = box.querySelector(".nb-form"), status = box.querySelector(".nb-status");
    var notes = seed(box) || [];
    function mine(n) { return n.edition === ed && (!item || n.item === item); }
    function say(t) { status.textContent = t; }
    function render() {
      var all = notes.filter(function (n) { return !item || n.item === item; })
        .concat(pending().filter(mine).map(function (n) { var c = JSON.parse(JSON.stringify(n)); c.pending = true; return c; }));
      all.sort(function (a, b) { return (a.at || "") < (b.at || "") ? -1 : 1; });
      list.innerHTML = all.length ? all.map(function (n) { return noteHTML(n, up, true); }).join("")
        : '<li class="nb-empty">Nothing logged yet. What stayed with you?</li>';
    }
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var text = form.elements.text.value.trim();
      if (!text) return;
      var picked = form.querySelector("input[name=kind]:checked");
      var n = { edition: ed, text: text, kind: picked ? picked.value : "learned",
                item: item, itemTitle: title, at: new Date().toISOString() };
      var btn = form.querySelector("button[type=submit]");
      btn.disabled = true;
      call("POST", "", n)
        .then(function (saved) { notes.push(saved); say("Saved."); })
        .catch(function () {
          var q = pending(); q.push(n); store(PENDING, q);
          say("Saved on this device. It syncs next time the site is online.");
        })
        .then(function () { form.elements.text.value = ""; btn.disabled = false; render(); });
    });
    list.addEventListener("click", function (e) {
      var b = e.target.closest(".nb-del");
      if (!b || !window.confirm("Remove this entry?")) return;
      var id = b.dataset.id, at = b.dataset.at;
      store(PENDING, pending().filter(function (n) { return n.at !== at; }));
      if (!id) { render(); return; }
      call("DELETE", "?edition=" + encodeURIComponent(ed) + "&id=" + encodeURIComponent(id))
        .then(function () { notes = notes.filter(function (n) { return n.id !== id; }); render(); })
        .catch(function () { say("Could not remove it. Try again when online."); });
    });
    render();
    flush()
      .then(function () { return call("GET", "?edition=" + encodeURIComponent(ed)); })
      .then(function (r) { notes = r; render(); })
      .catch(function () { if (canSync()) say("Showing the last saved copy."); });
  }

  // The full notebook page.
  function initAll(root) {
    var up = root.dataset.up || "", groups = root.querySelector(".nb-groups");
    var data = seed(root) || {}, filter = "all";
    function merged() {
      var out = JSON.parse(JSON.stringify(data));
      pending().forEach(function (n) { var c = JSON.parse(JSON.stringify(n)); c.pending = true; (out[n.edition] = out[n.edition] || []).push(c); });
      return out;
    }
    function render() {
      var d = merged(), html = "";
      Object.keys(d).sort().reverse().forEach(function (ed) {
        var ns = (d[ed] || []).filter(function (n) { return filter === "all" || n.kind === filter; });
        if (!ns.length) return;
        html += '<section class="nb-group"><h3><a href="' + up + "edition/" + h(ed) + '.html">' + h(longDate(ed)) +
          '</a></h3><ol class="nb-list">' + ns.map(function (n) { return noteHTML(n, up, false); }).join("") + "</ol></section>";
      });
      groups.innerHTML = html || '<p class="nb-empty">No entries yet. Open an edition and log what you learnt.</p>';
    }
    root.querySelectorAll("[data-filter]").forEach(function (b) {
      b.addEventListener("click", function () {
        filter = b.dataset.filter;
        root.querySelectorAll("[data-filter]").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
        render();
      });
    });
    root.querySelector(".nb-export").addEventListener("click", function () {
      var d = merged(), md = "# Notebook\n";
      Object.keys(d).sort().reverse().forEach(function (ed) {
        if (!(d[ed] || []).length) return;
        md += "\n## " + longDate(ed) + "\n";
        d[ed].forEach(function (n) {
          md += "- **" + (KINDS[n.kind] || "Note") + "**: " + n.text + (n.itemTitle ? " _(re: " + n.itemTitle + ")_" : "") + "\n";
        });
      });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
      a.download = "notebook.md";
      a.click();
    });
    render();
    flush().then(function () { return call("GET", ""); })
      .then(function (r) { data = r; render(); })
      .catch(function () {});
  }

  // Week in review: live character count, copy, share links follow edits.
  document.querySelectorAll("textarea[data-draft]").forEach(function (ta) {
    var counter = document.querySelector('[data-count-for="' + ta.id + '"]');
    var link = document.querySelector('[data-share-link="' + ta.id + '"]');
    function update() {
      if (counter) {
        var limit = Number(counter.dataset.limit || 0), n = ta.value.length;
        counter.textContent = limit ? n + " / " + limit : n + " characters";
        counter.classList.toggle("over", limit > 0 && n > limit);
      }
      if (link) link.href = link.dataset.base + encodeURIComponent(ta.value);
    }
    ta.addEventListener("input", update);
    update();
  });
  document.querySelectorAll("[data-copy]").forEach(function (b) {
    b.addEventListener("click", function () {
      var ta = document.getElementById(b.dataset.copy), label = b.textContent;
      function done() { b.textContent = "Copied"; setTimeout(function () { b.textContent = label; }, 1500); }
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(ta.value).then(done, function () { ta.select(); document.execCommand("copy"); done(); });
      } else { ta.select(); document.execCommand("copy"); done(); }
    });
  });

  // Angle desk: pick an angle, write, autosave to /api/drafts (and this device).
  function initPad(pad) {
    var week = pad.dataset.week, up = pad.dataset.up || "", KEY = "xr_draft_" + week;
    var angles = seed(pad) || [];
    var li = document.getElementById("d-li"), x = document.getElementById("d-x");
    var status = pad.querySelector(".pad-status");
    var d = store(KEY) || { angle: null, angleTitle: null, linkedin: "", x: "", posted: {}, updated: "" };
    var timer = null;
    function say(t) { status.textContent = t; }
    function show() {
      var a = angles.filter(function (z) { return z.id === d.angle; })[0];
      pad.querySelector(".pad-title").textContent = a ? a.title : "Pick an angle above, or write freely.";
      var turn = pad.querySelector(".pad-turn");
      turn.hidden = !(a && a.turn); turn.textContent = a ? a.turn : "";
      pad.querySelector(".pad-material").innerHTML = a ? a.material.map(function (m) {
        var body = m.kind === "stat" ? h(m.label) + ": <b>" + h(m.text) + "</b>"
          : m.kind === "story" ? '<a href="' + up + "item/" + h(m.item) + '.html">' + h(m.title) + "</a>"
          : m.kind === "vibe" ? "<b>" + h(m.title) + "</b>: " + h(m.text)
          : m.kind === "claim" ? "<b>" + h(m.title) + "</b> “" + h(m.text) + "”"
          : "“" + h(m.text) + "”";
        var tag = { stat: "Data", story: "Story", vibe: "Vibe", claim: "Number" }[m.kind] || "Note";
        return '<li><span class="nb-kind">' + tag + "</span>" + body + "</li>";
      }).join("") : "";
      pad.querySelector(".pad-prompts").innerHTML = a ? a.prompts.map(function (p) { return "<li>" + h(p) + "</li>"; }).join("") : "";
      document.querySelectorAll("[data-angle]").forEach(function (b) {
        var on = b.dataset.angle === d.angle;
        b.textContent = on ? "Writing this" : "Write this";
        b.closest(".angle").classList.toggle("picked", on);
      });
    }
    function fill() {
      li.value = d.linkedin || ""; x.value = d.x || "";
      [li, x].forEach(function (t) { t.dispatchEvent(new Event("input")); });
      pad.querySelectorAll("[data-posted]").forEach(function (c) { c.checked = !!(d.posted || {})[c.dataset.posted]; });
      show();
    }
    function save() {
      d.updated = new Date().toISOString();
      store(KEY, d);
      say("Saving…");
      clearTimeout(timer);
      timer = setTimeout(function () {
        call("PUT", "?week=" + encodeURIComponent(week), d, "/api/drafts")
          .then(function () { say("Saved."); })
          .catch(function () { say(canSync() ? "Saved on this device. It syncs when online." : "Saved on this device."); });
      }, 800);
    }
    li.addEventListener("input", function (e) { if (e.isTrusted) { d.linkedin = li.value; save(); } });
    x.addEventListener("input", function (e) { if (e.isTrusted) { d.x = x.value; save(); } });
    pad.querySelectorAll("[data-posted]").forEach(function (c) {
      c.addEventListener("change", function () { d.posted = d.posted || {}; d.posted[c.dataset.posted] = c.checked; save(); });
    });
    document.querySelectorAll("[data-angle]").forEach(function (b) {
      b.addEventListener("click", function () {
        var a = angles.filter(function (z) { return z.id === b.dataset.angle; })[0];
        if (!a) return;
        d.angle = a.id; d.angleTitle = a.title;
        save(); show();
        pad.scrollIntoView({ block: "start" });
        li.focus({ preventScroll: true });
      });
    });
    fill();
    call("GET", "?week=" + encodeURIComponent(week), null, "/api/drafts").then(function (r) {
      if (r && r.updated && r.updated > (d.updated || "")) { d = r; store(KEY, d); fill(); }
      else if (d.updated && (!r || !r.updated || d.updated > r.updated)) { save(); }
    }).catch(function () {});
  }
  var padEl = document.querySelector(".pad");
  if (padEl) initPad(padEl);

  document.querySelectorAll(".notebook[data-edition]").forEach(initBox);
  var all = document.querySelector(".nb-all");
  if (all) initAll(all);
})();
"""

# Cloudflare Pages Function. Lives at functions/api/notes.js. Uses the free KV tier.
NOTES_FUNCTION_JS = r"""// Managed by x_reader.py. Notebook API for the digest site.
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const ED = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = ["learned", "changed", "odd", "question", "todo"];
const key = (ed) => `notes:${ed}`;
const read = async (env, ed) => JSON.parse((await env.NOTES.get(key(ed))) || "[]");

export async function onRequestGet({ request, env }) {
  if (!env.NOTES) return json({ error: "NOTES KV binding missing" }, 500);
  const ed = new URL(request.url).searchParams.get("edition");
  if (ed) return ED.test(ed) ? json(await read(env, ed)) : json({ error: "bad edition" }, 400);
  const out = {};
  let cursor;
  do {
    const page = await env.NOTES.list({ prefix: "notes:", cursor });
    for (const k of page.keys) out[k.name.slice(6)] = await read(env, k.name.slice(6));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return json(out);
}

export async function onRequestPost({ request, env }) {
  if (!env.NOTES) return json({ error: "NOTES KV binding missing" }, 500);
  const b = await request.json().catch(() => null);
  const text = String((b && b.text) || "").trim();
  if (!b || !ED.test(b.edition || "") || !text) return json({ error: "bad input" }, 400);
  const list = await read(env, b.edition);
  const note = {
    id: crypto.randomUUID(), edition: b.edition, text: text.slice(0, 4000),
    kind: KINDS.includes(b.kind) ? b.kind : "learned",
    item: b.item ? String(b.item).slice(0, 40) : null,
    itemTitle: b.itemTitle ? String(b.itemTitle).slice(0, 300) : null,
    at: typeof b.at === "string" ? b.at.slice(0, 40) : new Date().toISOString(),
  };
  list.push(note);
  await env.NOTES.put(key(b.edition), JSON.stringify(list));
  return json(note, 201);
}

export async function onRequestDelete({ request, env }) {
  if (!env.NOTES) return json({ error: "NOTES KV binding missing" }, 500);
  const u = new URL(request.url);
  const ed = u.searchParams.get("edition"), id = u.searchParams.get("id");
  if (!ED.test(ed || "") || !id) return json({ error: "bad input" }, 400);
  const list = (await read(env, ed)).filter((n) => n.id !== id);
  await env.NOTES.put(key(ed), JSON.stringify(list));
  return json({ ok: true });
}
"""


# Cloudflare Pages Function at functions/api/drafts.js. Your writing, one draft per week.
DRAFTS_FUNCTION_JS = r"""// Managed by x_reader.py. Writing drafts for the angle desk.
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const WK = /^\d{4}-W\d{2}$/;
const key = (wk) => `drafts:${wk}`;

export async function onRequestGet({ request, env }) {
  if (!env.NOTES) return json({ error: "NOTES KV binding missing" }, 500);
  const wk = new URL(request.url).searchParams.get("week");
  if (!WK.test(wk || "")) return json({ error: "bad week" }, 400);
  return json(JSON.parse((await env.NOTES.get(key(wk))) || "{}"));
}

export async function onRequestPut({ request, env }) {
  if (!env.NOTES) return json({ error: "NOTES KV binding missing" }, 500);
  const wk = new URL(request.url).searchParams.get("week");
  const b = await request.json().catch(() => null);
  if (!WK.test(wk || "") || !b) return json({ error: "bad input" }, 400);
  const d = {
    angle: b.angle ? String(b.angle).slice(0, 20) : null,
    angleTitle: b.angleTitle ? String(b.angleTitle).slice(0, 200) : null,
    linkedin: String(b.linkedin || "").slice(0, 6000),
    x: String(b.x || "").slice(0, 2000),
    posted: { linkedin: !!(b.posted && b.posted.linkedin), x: !!(b.posted && b.posted.x) },
    updated: typeof b.updated === "string" ? b.updated.slice(0, 40) : new Date().toISOString(),
  };
  await env.NOTES.put(key(wk), JSON.stringify(d));
  return json(d);
}
"""


def _json_embed(obj) -> str:
    return json.dumps(obj, ensure_ascii=False).replace("</", "<\\/")


def _fmt_date(iso: str | None) -> str:
    if not iso:
        return ""
    try:
        d = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return f"{d:%b} {d.day}, {d.year}"
    except ValueError:
        return iso


def _long_date(ed: str) -> str:
    try:
        d = datetime.fromisoformat(ed)
        return f"{d:%A}, {d:%B} {d.day}, {d.year}"
    except ValueError:
        return ed


def _roman(n: int) -> str:
    out = ""
    for v, s in ((1000, "M"), (900, "CM"), (500, "D"), (400, "CD"), (100, "C"), (90, "XC"),
                 (50, "L"), (40, "XL"), (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I")):
        while n >= v:
            out, n = out + s, n - v
    return out


def _headline(it: dict) -> str:
    if it.get("title"):
        return it["title"]
    first = (it.get("text") or "").split("\n")[0]
    return (first[:110] + "…") if len(first) > 110 else (first or "(no text)")


def _kicker(it: dict) -> str:
    if it.get("kind") == "link":
        host = (urllib.parse.urlparse(it.get("url", "")).hostname or "").removeprefix("www.")
        return host or "Link"
    return {"article": "X Article", "tweet": "From the timeline"}.get(it.get("kind"), "Post")


def _links(it: dict, up: str, story_link: bool = True) -> str:
    b = []
    if it.get("pdf"):
        b.append(f"<a class='btn primary' href='{up}{esc(it['pdf'])}'>Read the PDF</a>")
    if story_link:
        b.append(f"<a class='btn' href='{up}item/{esc(it['id'])}.html'>Full story</a>")
    if it.get("url"):
        b.append(f"<a class='btn' href='{esc(it['url'])}'>Original</a>")
    b.append(f"<a class='btn' href='{esc(it['tweet_url'])}'>On X</a>")
    return f"<div class='links'>{''.join(b)}</div>"


def _doc(title: str, up: str, body: str) -> str:
    return ("<!doctype html><html lang='en'><head><meta charset='utf-8'>"
            "<meta name='viewport' content='width=device-width,initial-scale=1'>"
            "<meta name='robots' content='noindex'>"
            f"<title>{esc(title)}</title>{FONTS}<link rel='stylesheet' href='{up}style.css'>"
            f"</head><body><div class='sheet'>{body}</div>"
            f"<script src='{up}notebook.js' defer></script></body></html>")


def _masthead(up: str, left: str, right: str, dateline: str, mini: bool = False) -> str:
    return (f"<header class='mast{' mini' if mini else ''}'>"
            f"<div class='ears'><span>{left}</span><span>{right}</span></div>"
            f"<div class='name'><a href='{up}index.html'>{esc(SITE_TITLE)}</a></div>"
            + ("" if mini else f"<p class='motto'>{esc(SITE_MOTTO)}</p>")
            + f"<div class='dateline'>{dateline}</div></header>")


_LATEST_WEEK: str | None = None  # set by build_site()


def _dateline(up: str, vol: str, no: int, ed: str) -> str:
    return (f"<span>Vol. {vol} · No. {no}</span><span>{esc(_long_date(ed))}</span>"
            f"<span><a href='{up}archive.html'>Archive</a> · <a href='{up}notebook.html'>Notebook</a>"
            + (f" · <a href='{up}week/{_LATEST_WEEK}.html'>Angles</a>" if _LATEST_WEEK else "") + "</span>")


def _notebook_box(ed: str, up: str, seed: list, item: dict | None = None) -> str:
    chips = "".join(
        f"<label><input type='radio' name='kind' value='{k}'{' checked' if i == 0 else ''}><span>{v}</span></label>"
        for i, (k, v) in enumerate(NOTE_KINDS.items()))
    item_attrs = (f" data-item='{esc(item['id'])}' data-item-title='{esc(_headline(item))}'" if item else "")
    prompt = ("What did this story teach you?" if item else "What did you learn from this edition?") + \
        " Odd or funny things count. They become material for your posts."
    return (f"<section class='notebook' id='notebook' data-edition='{esc(ed)}' data-up='{up}'{item_attrs}>"
            f"<div class='nb-head'><h2>Notebook</h2><a href='{up}notebook.html'>All entries</a></div>"
            f"<p class='nb-sub'>{prompt}</p>"
            "<ol class='nb-list'></ol>"
            "<form class='nb-form'>"
            f"<fieldset class='chips'><legend class='sr'>Type of entry</legend>{chips}</fieldset>"
            "<label class='sr' for='nb-text'>Entry</label>"
            "<textarea id='nb-text' name='text' required placeholder='One idea, in a sentence or two.'></textarea>"
            "<div class='nb-actions'><button class='btn primary' type='submit'>Save to notebook</button>"
            "<span class='nb-status' role='status'></span></div></form>"
            f"<script type='application/json' class='nb-seed'>{_json_embed(seed)}</script></section>")


def _resurface(ed: str, notes: dict):
    """Pick one older note to show again, stable for the day."""
    pool = [(e, n) for e, ns in notes.items() if e < ed for n in ns]
    if not pool:
        return None
    old = [p for p in pool if (datetime.fromisoformat(ed) - datetime.fromisoformat(p[0])).days >= 7] or pool
    return old[int(hashlib.md5(ed.encode()).hexdigest(), 16) % len(old)]


def _edition_page(ed: str, items: list, no: int, vol: str, prev_ed, next_ed,
                  notes: dict, desk: dict, up: str) -> str:
    stories = [it for it in items if it["kind"] in ("link", "article")]
    lead = next((it for it in stories if it.get("summary")), None) or (stories or items)[0]
    others = [it for it in stories if it is not lead]
    dispatches = [it for it in items if it["kind"] == "tweet" and it is not lead]

    n_posts = len(dispatches) + (lead["kind"] == "tweet")
    ears_r = f"{len(stories)} {'story' if len(stories) == 1 else 'stories'} · {n_posts} {'post' if n_posts == 1 else 'posts'}"
    parts = [_masthead(up, "Read slowly. Think it through.", ears_r, _dateline(up, vol, no, ed))]

    if desk.get("note") or desk.get("question"):
        parts.append("<section class='desk'><div class='label'>From the editor's desk</div>"
                     + (f"<p class='note'>{esc(desk['note'])}</p>" if desk.get("note") else "")
                     + (f"<p class='q'>Today's question: {esc(desk['question'])}</p>" if desk.get("question") else "")
                     + "</section>")

    dek, bullets, why = _parse_summary(lead.get("summary"))
    if not dek and lead["kind"] == "tweet":
        dek = (lead.get("text") or "")[:300]
    lead_html = (f"<article class='lead' id='s-{esc(lead['id'])}'>"
                 f"<div class='kicker'>{esc(_kicker(lead))}</div>"
                 f"<h2><a href='{up}item/{esc(lead['id'])}.html'>{esc(_headline(lead))}</a></h2>"
                 + (f"<p class='dek'>{esc(dek)}</p>" if dek else "")
                 + f"<p class='byline'>Shared by {esc(lead['author'])} · @{esc(lead['handle'])} · {_fmt_date(lead.get('created_at'))}</p>"
                 + ("<ul class='brief'>" + "".join(f"<li>{esc(b)}</li>" for b in bullets) + "</ul>" if bullets else "")
                 + (f"<p class='why'><b>Why it matters</b>{esc(why)}</p>" if why else "")
                 + _links(lead, up) + "</article>")

    inside = "".join(f"<li><a href='#s-{esc(it['id'])}'>{esc(_headline(it))}</a></li>"
                     for it in [lead] + others + dispatches)
    side = f"<aside><h4>Inside this edition</h4><ol class='inside'>{inside}</ol>"
    old = _resurface(ed, notes)
    if old:
        old_ed, n = old
        side += ("<h4>From your notebook</h4><blockquote class='resurface'>"
                 f"<p>{esc(n.get('text'))}</p><p class='byline'>{esc(NOTE_KINDS.get(n.get('kind'), 'Note'))} · "
                 f"<a href='{up}edition/{esc(old_ed)}.html'>{esc(_fmt_date(old_ed))}</a></p></blockquote>")
    side += "</aside>"
    parts.append(f"<section class='front'>{lead_html}{side}</section>")

    if others:
        cards = []
        for it in others:
            d, _, _ = _parse_summary(it.get("summary"))
            cards.append(f"<article class='story' id='s-{esc(it['id'])}'><div class='kicker'>{esc(_kicker(it))}</div>"
                         f"<h3><a href='{up}item/{esc(it['id'])}.html'>{esc(_headline(it))}</a></h3>"
                         + (f"<p class='dek'>{esc(d)}</p>" if d else "")
                         + f"<p class='byline'>Shared by @{esc(it['handle'])}</p>"
                         + (f"<p class='err'>Could not fetch this page.</p>" if it.get("error") else "")
                         + _links(it, up, story_link=False) + "</article>")
        parts.append(f"<h2 class='section-head'>The reading list</h2><div class='grid'>{''.join(cards)}</div>")

    if dispatches:
        ds = []
        for it in dispatches:
            text = it.get("text") or ""
            short = text if len(text) <= 520 else text[:500].rsplit(" ", 1)[0] + "…"
            q = it.get("quoted")
            ds.append(f"<div class='dispatch' id='s-{esc(it['id'])}'>"
                      f"<div class='who'>{esc(it['author'])} <span>@{esc(it['handle'])}</span></div>"
                      f"<p>{esc(short)}</p>"
                      + (f"<div class='quote'><b>@{esc(q['handle'])}</b>: {esc(q['text'][:240])}</div>" if q else "")
                      + (f"<p class='byline'>With {len(it['images'])} image(s)</p>" if it.get("images") else "")
                      + f"<a class='more' href='{up}item/{esc(it['id'])}.html'>Read in full</a></div>")
        parts.append(f"<h2 class='section-head'>Dispatches</h2><div class='dispatches'>{''.join(ds)}</div>")

    parts.append(_notebook_box(ed, up, notes.get(ed, [])))
    nav_l = f"<a href='{up}edition/{prev_ed}.html'>Earlier edition</a>" if prev_ed else "<span>First edition</span>"
    nav_r = f"<a href='{up}edition/{next_ed}.html'>Later edition</a>" if next_ed else "<span>Latest edition</span>"
    parts.append(f"<footer class='foot'>{nav_l}<a href='{up}archive.html'>All editions</a>{nav_r}</footer>")
    return _doc(f"{SITE_TITLE} · {_long_date(ed)}", up, "".join(parts))


def _item_page(it: dict, no: int, vol: str, notes: dict) -> str:
    up, ed = "../", it["edition"]
    dek, bullets, why = _parse_summary(it.get("summary"))
    parts = [_masthead(up, f"<a href='{up}edition/{ed}.html'>Back to No. {no}</a>",
                       esc(_kicker(it)), _dateline(up, vol, no, ed), mini=True),
             "<article class='article'>",
             f"<div class='kicker'>{esc(_kicker(it))}</div><h1>{esc(_headline(it))}</h1>"]
    if dek:
        parts.append(f"<p class='dek'>{esc(dek)}</p>")
    parts.append(f"<p class='byline'>Shared by {esc(it['author'])} · @{esc(it['handle'])} · "
                 f"{_fmt_date(it.get('created_at'))}</p>")
    parts.append(_links(it, up, story_link=False))
    if it.get("error"):
        parts.append(f"<p class='err'>Could not process this link: {esc(it['error'])}</p>")
    if bullets:
        parts.append("<section class='inbrief'><h4>In brief</h4><ul class='brief'>"
                     + "".join(f"<li>{esc(b)}</li>" for b in bullets) + "</ul></section>")
    if why:
        parts.append(f"<p class='pull'>{esc(why)}</p>")
    parts.append(f"<div class='post'><div class='kicker'>The post · @{esc(it['handle'])}</div>"
                 f"<p>{esc(it.get('text'))}</p></div>")
    for img in it.get("images", []):
        parts.append(f"<img loading='lazy' src='{esc(img['src'])}' alt='{esc(img.get('alt'))}'>")
    q = it.get("quoted")
    if q:
        parts.append(f"<div class='post'><div class='kicker'>Quoting @{esc(q['handle'])}</div>"
                     f"<p>{esc(q['text'])}</p><p class='byline'><a href='{esc(q['url'])}'>Open on X</a></p></div>")
    if it.get("article_text"):
        paras = "".join(f"<p>{esc(p)}</p>" for p in it["article_text"].split("\n") if p.strip())
        parts.append(f"<div class='body'>{paras}</div>")
    for link in it.get("other_links", []):
        parts.append(f"<p class='byline'>Also linked: <a href='{esc(link)}'>{esc(link)}</a></p>")
    parts.append(_notebook_box(ed, up, [n for n in notes.get(ed, []) if n.get("item") == it["id"]], item=it))
    parts.append("</article>")
    return _doc(_headline(it), up, "".join(parts))


def build_site() -> None:
    global _LATEST_WEEK
    weeks = sorted(WEEKLY.glob("*.json")) if WEEKLY.exists() else []
    _LATEST_WEEK = weeks[-1].stem if weeks else None
    for d in ("item", "edition", "week"):
        (SITE / d).mkdir(parents=True, exist_ok=True)
    (SITE / "style.css").write_text(SITE_CSS)
    (SITE / "notebook.js").write_text(NOTEBOOK_JS)
    (SITE / "_headers").write_text(
        "/*\n  X-Robots-Tag: noindex, nofollow\n  Cache-Control: private, max-age=300\n")

    items = _load_items()
    notes = load_json(NOTES_FILE, {})
    eds = sorted({it["edition"] for it in items})
    first_year = int(eds[0][:4]) if eds else datetime.now().year
    vol = lambda ed: _roman(int(ed[:4]) - first_year + 1)
    number = {ed: i + 1 for i, ed in enumerate(eds)}
    by_ed = {ed: [it for it in items if it["edition"] == ed] for ed in eds}

    for i, ed in enumerate(eds):
        args = (ed, by_ed[ed], number[ed], vol(ed), eds[i - 1] if i else None,
                eds[i + 1] if i + 1 < len(eds) else None, notes, load_json(EDITIONS / f"{ed}.json", {}))
        (SITE / "edition" / f"{ed}.html").write_text(_edition_page(*args, up="../"))
        if i == len(eds) - 1:
            (SITE / "index.html").write_text(_edition_page(*args, up=""))
    if not eds:
        today = datetime.now().date().isoformat()
        (SITE / "index.html").write_text(_doc(SITE_TITLE, "", _masthead(
            "", "Read slowly. Think it through.", "No stories yet", _dateline("", "I", 0, today))
            + "<p class='empty'>The presses are quiet. Run a sync to print the first edition.</p>"))

    for it in items:
        (SITE / "item" / f"{it['id']}.html").write_text(
            _item_page(it, number[it["edition"]], vol(it["edition"]), notes))

    for wp in weeks:
        (SITE / "week" / f"{wp.stem}.html").write_text(_week_page(load_json(wp, {})))
    week_rows = "".join(
        f"<li><span class='no'>{esc(wp.stem[-3:])}</span><div><a href='week/{wp.stem}.html'>Angle desk</a>"
        f"<span class='sans'>{esc(wp.stem)}</span></div></li>" for wp in reversed(weeks))

    today = eds[-1] if eds else datetime.now().date().isoformat()
    rows = "".join(
        f"<li><span class='no'>No. {number[ed]}</span><div><a href='edition/{ed}.html'>{esc(_long_date(ed))}</a>"
        f"<span class='sans'>{len(by_ed[ed])} items · {len(notes.get(ed, []))} notebook entries"
        f"{' · ' + esc(_headline(by_ed[ed][0])) if by_ed[ed] else ''}</span></div></li>"
        for ed in reversed(eds))
    (SITE / "archive.html").write_text(_doc(f"{SITE_TITLE} · Archive", "", _masthead(
        "", "The archive", f"{len(eds)} editions", _dateline("", vol(today) if eds else "I", len(eds), today), mini=True)
        + f"<ol class='archive'>{rows or '<li>No editions yet.</li>'}</ol>"
        + (f"<h2 class='section-head'>Angle desks</h2><ol class='archive'>{week_rows}</ol>" if week_rows else "")))

    filters = "<button type='button' data-filter='all' aria-pressed='true'>All</button>" + "".join(
        f"<button type='button' data-filter='{k}' aria-pressed='false'>{v}</button>" for k, v in NOTE_KINDS.items())
    (SITE / "notebook.html").write_text(_doc(f"{SITE_TITLE} · Notebook", "", _masthead(
        "", "Your notebook", "What you learnt, edition by edition", _dateline("", vol(today) if eds else "I", len(eds), today), mini=True)
        + "<section class='nb-all' data-up=''>"
        + f"<div class='nb-actions' style='justify-content:space-between'><div class='chips'>{filters}</div>"
        + "<button type='button' class='btn nb-export'>Download as Markdown</button></div>"
        + "<div class='nb-groups'></div>"
        + f"<script type='application/json' class='nb-seed'>{_json_embed(notes)}</script></section>"))
    print(f"site built: {SITE / 'index.html'} ({len(items)} items, {len(eds)} editions)")


def cmd_build(_args) -> None:
    build_site()


# ---------- weekly stats ----------

X_LIMIT = 280


def _num(v: float):
    """1 decimal place, with no trailing .0 (6.0 -> 6)."""
    v = round(v, 1)
    return int(v) if v == int(v) else v


def _week_label(d) -> str:
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


def week_stats(items: list, notes: dict, start: str, end: str) -> dict:
    """Plain numbers about the week. Angles may only cite these."""
    wk_items = [it for it in items if start <= it["edition"] <= end]
    wk_notes = [n for ed, ns in notes.items() if start <= ed <= end for n in ns]
    kinds = {k: sum(1 for n in wk_notes if n.get("kind") == k) for k in NOTE_KINDS}
    domains: dict[str, int] = {}
    authors: dict[str, int] = {}
    days: dict[str, int] = {}
    for it in wk_items:
        if it["kind"] == "link":
            d = _kicker(it)
            domains[d] = domains.get(d, 0) + 1
        authors["@" + it["handle"]] = authors.get("@" + it["handle"], 0) + 1
        day = datetime.fromisoformat(it["edition"]).strftime("%A")
        days[day] = days.get(day, 0) + 1
    top = lambda d: sorted(d.items(), key=lambda kv: (-kv[1], kv[0]))[:3]
    editions = sorted({it["edition"] for it in wk_items})
    noted = sorted({n.get("edition") for n in wk_notes if n.get("edition")})
    return {
        "start": start, "end": end,
        "bookmarks": len(wk_items),
        "links": sum(1 for it in wk_items if it["kind"] == "link"),
        "posts": sum(1 for it in wk_items if it["kind"] == "tweet"),
        "pdfs": sum(1 for it in wk_items if it.get("pdf")),
        "editions": len(editions),
        "notes": len(wk_notes),
        "notes_by_kind": kinds,
        "editions_with_notes": len(noted),
        "notes_per_10_bookmarks": _num(10 * len(wk_notes) / len(wk_items)) if wk_items else 0,
        "top_domains": top(domains),
        "top_authors": top(authors),
        "busiest_day": top(days)[0][0] if days else None,
    }


def _stats_lines(st: dict) -> str:
    k = st["notes_by_kind"]
    lines = [
        f"- {st['bookmarks']} bookmarks saved ({st['links']} links, {st['posts']} posts)",
        f"- {st['editions']} daily editions printed, {st['pdfs']} PDFs",
        f"- {st['notes']} notebook entries: {k['learned']} learnt, {k['changed']} changed my mind, "
        f"{k['question']} open questions, {k['todo']} to act on, {k.get('odd', 0)} odd or funny",
        f"- {st['notes_per_10_bookmarks']} notes per 10 bookmarks",
    ]
    if st["top_domains"]:
        lines.append("- Most saved sources: " + ", ".join(f"{d} ({n})" for d, n in st["top_domains"]))
    if st["top_authors"]:
        lines.append("- Most saved people: " + ", ".join(f"{a} ({n})" for a, n in st["top_authors"]))
    if st["busiest_day"]:
        lines.append(f"- Busiest day: {st['busiest_day']}")
    return "\n".join(lines)


def _n(count, word: str, plural: str | None = None) -> str:
    return f"{count} {word if count == 1 else (plural or word + 's')}"


# ---------- the angle desk: connections and angles from your own material ----------
# Claude (or Ollama) does not write the posts. It finds links in what you read and
# wrote down, and pitches angles with evidence. You write.

ANGLE_TYPES = {
    "Reversal": "You changed your mind. Old you and new you disagree.",
    "Collision": "Two things you saved for different reasons say the same thing.",
    "Confession by numbers": "Your own numbers tell on you.",
    "Callback": "Something this week answers an old note or question.",
    "Odd pair": "Two things that should not connect, but do.",
    "Unpopular take": "Your notes point to a view most people would argue with.",
    "Vibe shift": "The mood on a topic moved, and your data shows when.",
    "Number drift": "The number people quote keeps changing.",
    "Bubble gap": "Your feed and the wider world feel different about the same thing.",
}

_STOP = set("""a about above after again against all also am an and any are as at be because been before
being below between both but by can could did do does doing down during each few for from further had has
have having he her here hers him his how i if in into is it its itself just like me more most my no nor not
now of off on once only or other our out over own same she should so some such than that the their them then
there these they this those through to too under until up very was we were what when where which while who
whom why will with would you your yours one two get got make made new now thing things way read reading
said says say going really actually still much many every week today post posts tweet thread via http https
com www amp""".split())


_SHORT_OK = {"ai", "ml", "eu", "us", "uk", "vc", "ev", "ip", "hr", "pm", "ux"}


def _words(text: str) -> set[str]:
    out = set()
    for w in re.findall(r"[a-z][a-z0-9'\-]{1,}", (text or "").lower()):
        w = w.strip("'-")
        if w in _STOP or (len(w) < 3 and w not in _SHORT_OK):
            continue
        if len(w) > 4 and w.endswith("s") and not w.endswith("ss"):
            w = w[:-1]
        out.add(w)
    return out


def _nums(text: str) -> set[str]:
    return {n.rstrip(".0") if "." in n else n for n in re.findall(r"\d+(?:\.\d+)?", text or "")}


def _story_text(it: dict) -> str:
    dek, bullets, why = _parse_summary(it.get("summary"))
    return " ".join([_headline(it), dek, *bullets, why, (it.get("text") or "")[:600]])


def ratio_history(items: list, notes: dict, today, days: int, weeks: int = 4) -> list:
    """Notes per 10 saves for the earlier windows, oldest first."""
    out = []
    for k in range(weeks, 0, -1):
        end = today - timedelta(days=days * k)
        start = end - timedelta(days=days - 1)
        s, e = start.isoformat(), end.isoformat()
        n_items = sum(1 for it in items if s <= it["edition"] <= e)
        n_notes = sum(len(ns) for ed, ns in notes.items() if s <= ed <= e)
        if n_items:
            out.append({"start": s, "end": e, "bookmarks": n_items, "notes": n_notes,
                        "per10": _num(10 * n_notes / n_items)})
    return out


def _flat_stats(st: dict) -> dict:
    """stat:<key> -> (label, value). The only numbers an angle may cite from stats."""
    k = st["notes_by_kind"]
    flat = {
        "bookmarks": ("Bookmarks saved", st["bookmarks"]),
        "links": ("Links saved", st["links"]),
        "posts": ("Posts saved", st["posts"]),
        "notes": ("Notebook entries", st["notes"]),
        "changed": ("Times you changed your mind", k.get("changed", 0)),
        "questions": ("Open questions logged", k.get("question", 0)),
        "odd": ("Odd or funny things logged", k.get("odd", 0)),
        "notes_per_10_bookmarks": ("Notes per 10 saves", st["notes_per_10_bookmarks"]),
        "editions": ("Editions printed", st["editions"]),
    }
    if st.get("top_domains"):
        d, c = st["top_domains"][0]
        flat["top_domain"] = ("Most saved source", f"{d} ({c})")
    if st.get("top_authors"):
        a, c = st["top_authors"][0]
        flat["top_author"] = ("Most saved account", f"{a} ({c})")
    if st.get("busiest_day"):
        flat["busiest_day"] = ("Busiest day", st["busiest_day"])
    hist = st.get("ratio_history") or []
    if hist:
        flat["prev_per10"] = ("Notes per 10 saves, the window before", hist[-1]["per10"])
        flat["avg_per10"] = ("Notes per 10 saves, average of earlier windows",
                             round(sum(h["per10"] for h in hist) / len(hist), 1))
    return flat


def _material(items: list, notes: dict, start: str, end: str) -> dict:
    """ref -> piece. Notes from all time, stories from this window."""
    pieces = {}
    for ed, ns in notes.items():
        for n in ns:
            if not n.get("id"):
                continue
            pieces[f"n:{n['id']}"] = {
                "ref": f"n:{n['id']}", "type": "note", "date": ed, "this_week": start <= ed <= end,
                "kind": n.get("kind"), "item": n.get("item"),
                "label": f"Note · {NOTE_KINDS.get(n.get('kind'), 'Note')} · {_fmt_date(ed)}",
                "text": n.get("text", ""), "title": n.get("itemTitle") or "",
                "words": _words(n.get("text", "") + " " + (n.get("itemTitle") or "")),
            }
    for it in items:
        if not (start <= it["edition"] <= end):
            continue
        pieces[f"s:{it['id']}"] = {
            "ref": f"s:{it['id']}", "type": "story", "date": it["edition"], "this_week": True,
            "id": it["id"], "source": _kicker(it), "handle": it.get("handle"),
            "label": f"Story · {_kicker(it)} · @{it.get('handle')}",
            "text": (_parse_summary(it.get("summary"))[0] or (it.get("text") or ""))[:300],
            "title": _headline(it), "words": _words(_story_text(it)),
        }
    return pieces


def find_links(pieces: dict, st: dict, notes: dict, items: list, start: str, end: str) -> list[dict]:
    """Plain code finds candidate links. The model then judges and pitches."""
    import math
    df: dict[str, int] = {}
    for p in pieces.values():
        for w in p["words"]:
            df[w] = df.get(w, 0) + 1
    N = max(1, len(pieces))
    idf = {w: math.log(1 + N / c) for w, c in df.items()}

    pairs = []
    refs = list(pieces)
    for i, a in enumerate(refs):
        for b in refs[i + 1:]:
            pa, pb = pieces[a], pieces[b]
            if not (pa["this_week"] or pb["this_week"]):
                continue
            if pa["type"] == "note" and pb["type"] == "story" and pa.get("item") == pb.get("id"):
                continue  # a note about its own story: too obvious
            if pb["type"] == "note" and pa["type"] == "story" and pb.get("item") == pa.get("id"):
                continue
            shared = pa["words"] & pb["words"]
            if not shared:
                continue
            score = sum(idf[w] for w in shared)
            if len(shared) < 2 and score < 2.5:
                continue
            if pa["type"] == "story" and pb["type"] == "story" and pa.get("source") != pb.get("source"):
                score *= 1.2  # different sources agreeing is more interesting
            if pa["type"] != pb["type"]:
                score *= 1.1
            gap = abs((datetime.fromisoformat(pa["date"]) - datetime.fromisoformat(pb["date"])).days)
            pairs.append({"a": a, "b": b, "shared": sorted(shared, key=lambda w: -idf[w])[:5],
                          "score": round(score, 2), "gap_days": gap})
    pairs.sort(key=lambda p: -p["score"])

    found = []
    # 1. reversals: a "changed my mind" note this week + the closest older note
    for ref, p in pieces.items():
        if p["type"] == "note" and p["this_week"] and p["kind"] == "changed":
            old = [q for q in pairs if ref in (q["a"], q["b"])
                   and not pieces[q["b"] if q["a"] == ref else q["a"]]["this_week"]
                   and pieces[q["b"] if q["a"] == ref else q["a"]]["type"] == "note"]
            if old:
                o = old[0]
                found.append({"kind": "Reversal", "refs": [o["a"], o["b"]], "shared": o["shared"],
                              "why": f"a changed-my-mind note links to an older note, {o['gap_days']} days apart"})
            else:
                found.append({"kind": "Reversal", "refs": [ref], "shared": [], "why": "a changed-my-mind note this week"})
    # 2. callbacks: an older open question that this week's reading touches
    calls: dict[str, dict] = {}
    for q in pairs:
        pa, pb = pieces[q["a"]], pieces[q["b"]]
        old, new = (pa, pb) if not pa["this_week"] else (pb, pa) if not pb["this_week"] else (None, None)
        if old and old["type"] == "note" and old["kind"] == "question":
            c = calls.setdefault(old["ref"], {"kind": "Callback", "refs": [old["ref"]], "shared": [],
                                              "why": f"an open question from {_fmt_date(old['date'])} meets this week's reading"})
            if len(c["refs"]) < 3:
                c["refs"].append(new["ref"])
                c["shared"] = sorted(set(c["shared"]) | set(q["shared"]))[:5]
    found.extend(calls.values())
    # 3. odd notes: raw humor material you logged yourself
    for ref, p in pieces.items():
        if p["type"] == "note" and p["this_week"] and p["kind"] == "odd":
            found.append({"kind": "Odd pair", "refs": [ref], "shared": [], "why": "you logged this as odd or funny"})
    # 4. collisions: the strongest cross-piece links not already covered
    from itertools import combinations
    used = {tuple(sorted(c)) for f in found for c in combinations(f["refs"], 2)}
    for q in pairs:
        key = tuple(sorted((q["a"], q["b"])))
        if key in used:
            continue
        used.add(key)
        kind = "Collision" if pieces[q["a"]]["type"] == pieces[q["b"]]["type"] == "story" else "Odd pair"
        found.append({"kind": kind, "refs": [q["a"], q["b"]], "shared": q["shared"],
                      "why": f"shared words: {', '.join(q['shared'])}"})
        if sum(1 for f in found if f["kind"] in ("Collision", "Odd pair")) >= 5:
            break
    # 5. confession by numbers
    hist = st.get("ratio_history") or []
    if st["bookmarks"]:
        why = f"{st['bookmarks']} saves, {st['notes']} notes"
        if hist:
            why += f"; the window before was {hist[-1]['per10']} notes per 10 saves, now {st['notes_per_10_bookmarks']}"
        found.append({"kind": "Confession by numbers", "refs": ["stat:bookmarks", "stat:notes", "stat:notes_per_10_bookmarks"]
                      + (["stat:prev_per10"] if hist else []), "shared": [], "why": why})
    # 6. gaps: a source you save a lot and never write about
    noted_items = {n.get("item") for ns in notes.values() for n in ns if n.get("item")}
    for d, c in st.get("top_domains", []):
        if c >= 2:
            ids = [it["id"] for it in items if start <= it["edition"] <= end and _kicker(it) == d]
            if not any(i in noted_items for i in ids):
                found.append({"kind": "Confession by numbers", "refs": ["stat:top_domain"] + [f"s:{i}" for i in ids[:2]],
                              "shared": [], "why": f"{d}: {c} saves and 0 notes"})
                break
    return _diverse(found)[:12]


def _diverse(found: list) -> list:
    """Round-robin by kind, so one strong type does not crowd out the rest."""
    order, groups = [], {}
    for f in found:
        if f["kind"] not in groups:
            order.append(f["kind"])
        groups.setdefault(f["kind"], []).append(f)
    out = []
    while any(groups.values()):
        for k in order:
            if groups[k]:
                out.append(groups[k].pop(0))
    return out


def _clip(text: str, n: int = 48) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= n else text[:n].rsplit(" ", 1)[0].rstrip(",.;:") + "…"


def _piece_line(p: dict) -> str:
    extra = f" (re: {p['title']})" if p["type"] == "note" and p.get("title") else ""
    head = f"{p['title']}: " if p["type"] in ("story", "vibe") else ""
    return f"[{p['ref']}] ({p['label']}) {head}{p['text']}{extra}"


def _template_angles(found: list, pieces: dict, flat: dict) -> list[dict]:
    """No model: turn the code's findings into plain angles. Less clever, still true."""
    prompts = {
        "Reversal": ["What did you believe before, in one sentence?", "What exact thing changed your mind?",
                     "What did the old you get right?"],
        "Callback": ["Is your old question answered now, or only moved?", "What would you tell yourself on that date?"],
        "Collision": ["Why did you save each one? Was it the same reason?", "What would the two authors argue about?"],
        "Odd pair": ["Where were you when you saved these?", "What is the one sentence that joins them?"],
        "Vibe shift": ["When did you first feel the mood change? What did you see?",
                       "Were you early, on time, or late to this shift?",
                       "What would you tell someone who still feels the old mood?"],
        "Number drift": ["Which number do you believe, and why?", "Who benefits from the bigger number?",
                         "What number would change your mind?"],
        "Bubble gap": ["Is your feed ahead of the news, or in a bubble?", "Who do you follow on this, and why them?"],
        "Confession by numbers": ["What do you do with the bookmarks you never open?",
                                  "Which one save was worth all the rest?"],
    }
    out = []
    for i, f in enumerate(found[:6]):
        texts = [pieces[r]["title"] or pieces[r]["text"][:80] for r in f["refs"] if r in pieces]
        title = {"Reversal": "You changed your mind",
                 "Callback": "An old question meets this week",
                 "Confession by numbers": "Your numbers tell on you",
                 "Vibe shift": f"The mood on {texts[0] if texts else 'this'} moved",
                 "Number drift": "The number keeps changing",
                 "Bubble gap": f"Your feed and the news disagree on {texts[0] if texts else 'this'}"}.get(
            f["kind"], " meets ".join(f"“{_clip(t, 40)}”" for t in texts[:2]) or "Start with the odd thing")
        out.append({
            "id": f"a{i + 1}", "type": f["kind"], "title": title,
            "connection": f["why"][:1].upper() + f["why"][1:] + ".",
            "evidence": f["refs"], "turn": ANGLE_TYPES.get(f["kind"], ""),
            "true_detail": texts[0] if texts else "",
            "prompts": prompts.get(f["kind"], prompts["Odd pair"]),
            "fits": ["linkedin", "x"], "avoid": "Do not explain the joke. Say the true thing and stop.",
            "source": "code",
        })
    return out


def _parse_json_obj(text: str):
    text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.S)
    i, j = text.find("{"), text.rfind("}")
    if i < 0 or j <= i:
        return None
    try:
        return json.loads(text[i:j + 1])
    except json.JSONDecodeError:
        return None


def pitch_angles(found: list, pieces: dict, st: dict, llm, used: list[str]) -> list[dict]:
    flat = _flat_stats(st)
    if not llm or not found:
        return _template_angles(found, pieces, flat)
    week = [p for p in pieces.values() if p["this_week"] and p["type"] in ("note", "story")]
    market = [p for p in pieces.values() if p["type"] in ("vibe", "claim")]
    old_notes = sorted((p for p in pieces.values() if not p["this_week"]), key=lambda p: p["date"], reverse=True)
    linked = {r for f in found for r in f["refs"]}
    old = [p for p in old_notes if p["ref"] in linked] + [p for p in old_notes if p["ref"] not in linked]
    material = "\n".join(_piece_line(p) for p in week[:30] + old[:40])
    stats = "\n".join(f"[stat:{k}] {lbl}: {v}" for k, (lbl, v) in flat.items())
    leads = "\n".join(f"F{i + 1}. {f['kind']}: {', '.join(f['refs'])}. {f['why']}" for i, f in enumerate(found))
    types = "\n".join(f"- {k}: {v}" for k, v in ANGLE_TYPES.items())
    prompt = (
        f"You are a sharp, kind editor and comedy writer for {AUTHOR_BIO}.\n"
        "You do NOT write posts. The author writes. Your job is to find connections in the author's own "
        "reading and notes, and pitch angles for one LinkedIn post and one X post this week.\n\n"
        "A good angle:\n"
        "- links two or more pieces of material the author would not have put together;\n"
        "- gets its humor from something TRUE in the material: a reversal, a gap between what they save and "
        "what they do, an odd pair, a number that tells on them. Self-aware. Never mean. Never about private people;\n"
        "- or shows how the mood or the numbers on a topic moved over time, and what the author saw first or late;\n"
        "- leaves the reader with one useful idea;\n"
        "- sounds like a person, not a brand.\n"
        "Use only facts, names and numbers that appear in the material or stats below. Never invent.\n\n"
        f"Angle types:\n{types}\n\n"
        "Return JSON only, in this shape: {\"angles\": [5 objects]}. Each object:\n"
        "{\"type\": one of the types above, \"title\": \"10 words or fewer\", "
        "\"connection\": \"1 or 2 sentences: what links the pieces\", "
        "\"evidence\": [\"refs exactly as written in the material, for example n:..., s:..., stat:...\"], "
        "\"turn\": \"1 sentence: the surprising or funny observation, stated plainly. Do not write the joke.\", "
        "\"true_detail\": \"the one concrete detail from the material that makes this angle the author's own\", "
        "\"prompts\": [\"2 or 3 questions that only the author can answer\"], "
        "\"fits\": [\"linkedin\" and or \"x\"], "
        "\"avoid\": \"1 sentence: how this angle could go fake or cringe\"}\n"
        "Pitch at least one angle that fits X (one idea, very short) and at least one for LinkedIn.\n"
        + (f"Do not repeat these angles from earlier weeks: {'; '.join(used[:15])}\n" if used else "")
        + f"\nLinks the code found (use them, or find better ones):\n{leads}\n\n"
        f"Stats:\n{stats}\n\n"
        + ("Market vibes and numbers over time (vibe: = a topic's trend, claim: = a number quoted in a story):\n"
           + "\n".join(_piece_line(p) for p in market[:30]) + "\n\n" if market else "")
        + f"Material:\n{material}\n")
    try:
        data = _parse_json_obj(llm(prompt)) or {}
    except Exception as e:
        print(f"  angle pitch failed, using code findings: {e}")
        return _template_angles(found, pieces, flat)
    raw = data.get("angles") if isinstance(data, dict) else None
    if not isinstance(raw, list) or not raw:
        print("  model gave no usable angles, using code findings")
        return _template_angles(found, pieces, flat)
    out = []
    for i, a in enumerate(raw[:7]):
        if not isinstance(a, dict):
            continue
        ev = [r for r in a.get("evidence", []) if isinstance(r, str)
              and (r in pieces or (r.startswith("stat:") and r[5:] in flat))]
        if not ev or not a.get("title"):
            continue
        out.append({
            "id": f"a{i + 1}", "type": a.get("type") if a.get("type") in ANGLE_TYPES else "Odd pair",
            "title": str(a["title"])[:120], "connection": str(a.get("connection", ""))[:500],
            "evidence": ev[:6], "turn": str(a.get("turn", ""))[:300],
            "true_detail": str(a.get("true_detail", ""))[:300],
            "prompts": [str(p)[:200] for p in (a.get("prompts") or [])[:3]],
            "fits": [f for f in (a.get("fits") or ["linkedin", "x"]) if f in ("linkedin", "x")] or ["linkedin", "x"],
            "avoid": str(a.get("avoid", ""))[:250], "source": "model",
        })
    return out or _template_angles(found, pieces, flat)


def check_angles(angles: list, pieces: dict, flat: dict) -> None:
    """Flag any number in an angle that is not in your data."""
    allowed = set()
    for p in pieces.values():
        allowed |= _nums(f"{p['text']} {p['title']} {p['date']} {_fmt_date(p['date'])}")
    for lbl, v in flat.values():
        allowed |= _nums(str(v))
    for a in angles:
        seen = _nums(" ".join([a["title"], a["connection"], a["turn"], a["true_detail"]]))
        bad = sorted(seen - allowed)
        if bad:
            a["check"] = "Not in your data, so check before you use: " + ", ".join(bad)


def resolve_material(angles: list, pieces: dict, flat: dict) -> None:
    for a in angles:
        mat = []
        for r in a["evidence"]:
            if r.startswith("stat:"):
                lbl, v = flat[r[5:]]
                mat.append({"kind": "stat", "label": lbl, "text": str(v)})
            elif r in pieces:
                p = pieces[r]
                m = {"kind": p["type"], "label": p["label"], "text": p["text"], "title": p["title"]}
                if p["type"] == "story":
                    m["item"] = p["id"]
                elif p.get("item"):
                    m["item"] = p["item"]
                mat.append(m)
        a["material"] = mat


def _used_angles(drafts: dict) -> list[str]:
    return [d.get("angleTitle") for _, d in sorted(drafts.items(), reverse=True)
            if d.get("angleTitle") and (d.get("linkedin") or d.get("x"))]


def pull_drafts() -> dict:
    """Copy your writing drafts from Cloudflare KV to xreader_data/drafts.json."""
    path = DATA / "drafts.json"
    if not CF_KV_NOTES_ID:
        return load_json(path, {})
    try:
        out = {}
        for k in _json_from(_wrangler_kv("list", "--prefix", "drafts:")):
            raw = _wrangler_kv("get", k["name"])
            i = raw.find("{")
            out[k["name"][len("drafts:"):]] = json.loads(raw[i:]) if i >= 0 else {}
    except Exception as e:
        print(f"  could not pull drafts: {e}")
        return load_json(path, {})
    save_json(path, out)
    return out


# ---------- vibes: how the mood and the numbers on a topic move over time ----------
# Three free sources, no keys:
#   your feed     tone of what you saved (VADER if installed, else a small built-in word list)
#   news          GDELT DOC 2.0 API: average tone and article count, last 3 months max
#   tech crowd    Hacker News (Algolia API): stories per week and their points
# Plus "numbers in circulation": figures quoted in your saved stories, tracked over time.

VIBE_LABELS = ["excited", "worried", "skeptical", "practical", "angry", "amused"]
GDELT_URL = "https://api.gdeltproject.org/api/v2/doc/doc"
HN_URL = "https://hn.algolia.com/api/v1/search_by_date"

_POS = set("""gain gains grow growth growing win wins won strong stronger best better boom booming surge surges record
breakthrough opportunity opportunities optimistic bullish upside improve improves improved success successful
progress promising beat beats exciting excited love great good positive rally rallies soar soars thrive cheaper
faster efficient profit profitable adoption adopt wins easy clear clearer working works useful""".split())
_NEG = set("""loss losses lose losing fall falls fell decline declines drop drops weak weaker worst worse bust crash
risk risks risky fear fears worried worry concern concerns pessimistic bearish downside fail fails failed failure
failing problem problems crisis threat threats layoffs layoff ban bans lawsuit lawsuits sue sued fine fined
liability liable breach hype bubble overvalued slow slower expensive costly scam broken stall stalls stalled
collapse collapses warning warns doubt doubts skeptical angry hard harder chaos mess""".split())
_NEGATE = {"not", "no", "never", "without", "hardly", "isn't", "aren't", "wasn't", "don't", "doesn't", "didn't", "won't"}

_vader = None


def _tone(text: str) -> float:
    """-1 (negative) to +1 (positive)."""
    global _vader
    if _vader is None:
        try:
            from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
            _vader = SentimentIntensityAnalyzer()
        except Exception:
            _vader = False
    if _vader:
        return round(_vader.polarity_scores(text or "")["compound"], 3)
    words = re.findall(r"[a-z']+", (text or "").lower())
    score = hits = 0
    for i, w in enumerate(words):
        s = 1 if w in _POS else -1 if w in _NEG else 0
        if s:
            if any(p in _NEGATE for p in words[max(0, i - 3):i]):
                s = -s
            score += s
            hits += 1
    return round(score / (hits + 2), 3) if hits else 0.0


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:40]


def _topic_words(topic: str) -> set[str]:
    return _words(topic)


def _matches(topic: str, words: set[str]) -> bool:
    tw = _topic_words(topic)
    return bool(tw) and tw <= words


def _ordered_tokens(text: str) -> list[str]:
    toks = []
    for w in re.findall(r"[A-Za-z][A-Za-z0-9'\-]+", text or ""):
        lw = w.lower().strip("'-")
        if lw in _STOP or (len(lw) < 3 and lw not in _SHORT_OK):
            toks.append(None)  # a stopword breaks a phrase
        else:
            toks.append(w.strip("'-"))
    return toks


def pick_topics(items: list, notes: dict, start: str, end: str, n: int = 6) -> list[str]:
    """WATCH_TOPICS from .env wins. Else the phrases you saved most in the window."""
    if WATCH_TOPICS:
        return WATCH_TOPICS
    docs = [it for it in items if start <= it["edition"] <= end]
    texts = [_story_text(it) for it in docs] + [n_["text"] for ed, ns in notes.items() if start <= ed <= end for n_ in ns]
    df_bi: dict[str, int] = {}
    df_uni: dict[str, int] = {}
    shown: dict[str, str] = {}
    for t in texts:
        toks = _ordered_tokens(t)
        seen_bi, seen_uni = set(), set()
        for a, b in zip(toks, toks[1:]):
            if a and b:
                k = f"{a.lower()} {b.lower()}"
                seen_bi.add(k)
                shown.setdefault(k, f"{a} {b}")
        for a in toks:
            if a:
                seen_uni.add(a.lower())
                shown.setdefault(a.lower(), a)
        for k in seen_bi:
            df_bi[k] = df_bi.get(k, 0) + 1
        for k in seen_uni:
            df_uni[k] = df_uni.get(k, 0) + 1
    topics: list[str] = []
    for k, c in sorted(df_bi.items(), key=lambda kv: -kv[1]):
        if c >= 3 and len(topics) < n:
            topics.append(shown[k])
    covered = {w for t in topics for w in t.lower().split()}
    for k, c in sorted(df_uni.items(), key=lambda kv: -kv[1]):
        if len(topics) >= n:
            break
        if c >= 4 and k not in covered and not k.isdigit():
            topics.append(shown[k])
    return topics


def _windows(today, weeks: int) -> list[tuple[str, str]]:
    """Oldest first. Each is 7 days ending on the same weekday as today."""
    out = []
    for w in range(weeks - 1, -1, -1):
        e = today - timedelta(days=7 * w)
        out.append(((e - timedelta(days=6)).isoformat(), e.isoformat()))
    return out


def _bucket(windows, iso_day: str):
    for i, (s, e) in enumerate(windows):
        if s <= iso_day <= e:
            return i
    return None


def tag_vibes(items: list, llm, cap: int = 80) -> None:
    """Tone for every item (free, local). A one-word vibe from the model, cached."""
    changed = []
    for it in items:
        if "tone" not in it:
            it["tone"] = _tone(_story_text(it))
            changed.append(it)
    todo = [it for it in items if "vibe" not in it][:cap] if llm else []
    for i in range(0, len(todo), 20):
        batch = todo[i:i + 20]
        lines = "\n".join(f"{j + 1}. {_clip(_story_text(it), 400)}" for j, it in enumerate(batch))
        prompt = ("For each numbered post, give the one word that best fits its mood: "
                  f"{', '.join(VIBE_LABELS)}.\nReturn JSON only, like {{\"1\": \"worried\", \"2\": \"excited\"}}.\n\n{lines}")
        try:
            data = _parse_json_obj(llm(prompt)) or {}
        except Exception as e:
            print(f"  vibe tagging failed: {e}")
            break
        for j, it in enumerate(batch):
            v = str(data.get(str(j + 1), "")).lower().strip()
            if v in VIBE_LABELS:
                it["vibe"] = v
                changed.append(it)
    for it in {id(x): x for x in changed}.values():
        p = ITEMS / f"{it['id']}.json"
        if p.exists():
            raw = load_json(p, {})
            raw.update({k: it[k] for k in ("tone", "vibe") if k in it})
            save_json(p, raw)


# ---- external sources (cached for a day) ----

_last_gdelt = [0.0]


def _cached(name: str, fn):
    path = VIBES / f"{datetime.now().date().isoformat()}-{name}.json"
    if path.exists():
        return load_json(path, None)
    try:
        val = fn()
    except Exception as e:
        print(f"  {name}: not available ({type(e).__name__})")
        return None
    if val is not None:
        save_json(path, val)
    return val


def _gdelt_timeline(topic: str, mode: str, weeks: int):
    def fetch():
        wait = 5.5 - (time.time() - _last_gdelt[0])  # GDELT asks for one request every 5 seconds
        if wait > 0:
            time.sleep(wait)
        q = f'"{topic}"' if " " in topic.strip() else topic
        r = httpx.get(GDELT_URL, timeout=40, headers={"User-Agent": UA}, params={
            "query": f"{q} sourcelang:english", "mode": mode, "format": "json",
            "timespan": f"{min(weeks, 13)}w"})
        _last_gdelt[0] = time.time()
        r.raise_for_status()
        try:
            data = r.json()
        except ValueError:
            raise RuntimeError(r.text[:120])
        out = []
        for series in data.get("timeline", []):
            for pt in series.get("data", []):
                d = str(pt.get("date", ""))[:8]
                if len(d) == 8:
                    out.append([f"{d[:4]}-{d[4:6]}-{d[6:]}", float(pt.get("value", 0))])
            break  # first series: "Average Tone" or "Article Count"
        return out
    return _cached(f"gdelt-{mode}-{_slug(topic)}", fetch)


def _hn_weekly(topic: str, windows):
    def fetch():
        out = []
        for s, e in windows:
            a = int(datetime.fromisoformat(s).replace(tzinfo=timezone.utc).timestamp())
            b = int((datetime.fromisoformat(e) + timedelta(days=1)).replace(tzinfo=timezone.utc).timestamp())
            r = httpx.get(HN_URL, timeout=30, params={
                "query": topic, "tags": "story", "hitsPerPage": 50,
                "numericFilters": f"created_at_i>={a},created_at_i<{b}"})
            r.raise_for_status()
            d = r.json()
            pts = [h.get("points") or 0 for h in d.get("hits", [])]
            out.append({"stories": int(d.get("nbHits", 0)),
                        "points": round(sum(pts) / len(pts), 1) if pts else None})
        return out
    return _cached(f"hn-{_slug(topic)}-{windows[-1][1]}", fetch)


# ---- numbers in circulation ----

_CLAIM_RE = re.compile(r"(\$\s?\d[\d,.]*\s?(?:[bmk]n?|billion|million|trillion)?|\d[\d,.]*\s?(?:%|percent|x\b|×|"
                       r"billion|million|trillion|bn\b))", re.I)


def extract_claims(items: list) -> list[dict]:
    out = []
    for it in items:
        dek, bullets, why = _parse_summary(it.get("summary"))
        parts = [dek, *bullets, why] if it.get("summary") else re.split(r"(?<=[.!?])\s+", it.get("text") or "")
        for k, sent in enumerate(p for p in parts if p):
            m = _CLAIM_RE.search(sent)
            if not m:
                continue
            raw = m.group(1).strip()
            unit = ("%" if re.search(r"%|percent", raw, re.I) else "x" if re.search(r"x|×", raw, re.I)
                    else "$" if "$" in raw else "count")
            num = re.search(r"\d[\d,]*(?:\.\d+)?", raw).group(0).replace(",", "")
            out.append({"id": f"{it['id']}-{k}", "item": it["id"], "date": it["edition"], "source": _kicker(it),
                        "handle": it.get("handle"), "text": _clip(sent, 220), "value": float(num), "unit": unit,
                        "raw": raw, "words": _words(re.sub(r"\d", " ", sent))})
    return sorted(out, key=lambda c: c["date"])


def number_drifts(claims: list) -> list[dict]:
    """Claims about the same thing (same unit, 2+ shared words) whose number changed."""
    groups, used = [], set()
    for i, a in enumerate(claims):
        if a["id"] in used:
            continue
        g = [a]
        for b in claims[i + 1:]:
            if b["id"] in used or b["unit"] != a["unit"] or b["item"] == a["item"]:
                continue
            if len(a["words"] & b["words"]) >= 2:
                g.append(b)
        if len(g) >= 2 and len({c["value"] for c in g}) >= 2:
            used |= {c["id"] for c in g}
            shared = set.intersection(*(c["words"] for c in g)) or (g[0]["words"] & g[1]["words"])
            groups.append({"about": " ".join(sorted(shared)[:4]), "claims": g})
    return groups


# ---- shifts ----

def _mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def _shift(series: list, kind: str, recent: int = 2):
    """Compare the last `recent` weeks with the weeks before. kind: 'tone' or 'count'."""
    base, now = _mean(series[:-recent]), _mean(series[-recent:])
    if base is None or now is None or sum(1 for x in series[:-recent] if x is not None) < 2:
        return None
    if kind == "count":
        if base == 0:
            return {"label": "New" if now > 0 else "Steady", "before": 0, "now": round(now, 1), "ratio": None}
        r = now / base
        lab = "Louder" if r >= 1.5 else "Quieter" if r <= 0.67 else "Steady"
        return {"label": lab, "before": round(base, 1), "now": round(now, 1), "ratio": round(r, 1)}
    d = now - base
    step = 0.15 if kind == "tone" else 0.5  # 'news' tone is on GDELT's wider scale
    lab = "Warming" if d >= step else "Souring" if d <= -step else "Steady"
    return {"label": lab, "before": round(base, 2), "now": round(now, 2), "delta": round(d, 2)}


def build_vibes(items: list, notes: dict, today, llm, external: bool = True) -> dict:
    weeks = max(4, VIBE_WEEKS)
    wins = _windows(today, weeks)
    start, end = wins[0][0], wins[-1][1]
    tag_vibes([it for it in items if start <= it["edition"] <= end], llm)
    topics = pick_topics(items, notes, (today - timedelta(days=27)).isoformat(), end)
    claims = extract_claims([it for it in items if start <= it["edition"] <= end])
    out = {"weeks": [s for s, _ in wins], "topics": [], "drifts": [], "sources": {}}
    for topic in topics:
        mine = [it for it in items if start <= it["edition"] <= end and _matches(topic, _words(_story_text(it)))]
        t = {"topic": topic, "slug": _slug(topic),
             "saves": [0] * weeks, "tone": [None] * weeks, "notes": [0] * weeks,
             "vibes_recent": {}, "vibes_before": {}, "news_tone": None, "news_volume": None, "hn": None}
        tones = [[] for _ in range(weeks)]
        for it in mine:
            b = _bucket(wins, it["edition"])
            if b is None:
                continue
            t["saves"][b] += 1
            tones[b].append(it.get("tone", 0.0))
            if it.get("vibe"):
                side = "vibes_recent" if b >= weeks - 2 else "vibes_before"
                t[side][it["vibe"]] = t[side].get(it["vibe"], 0) + 1
        t["tone"] = [round(sum(x) / len(x), 2) if x else None for x in tones]
        for ed, ns in notes.items():
            b = _bucket(wins, ed)
            if b is not None:
                t["notes"][b] += sum(1 for n in ns if _matches(topic, _words(n.get("text", "") + " " + (n.get("itemTitle") or ""))))
        if external and "gdelt" in VIBES_EXTERNAL:
            for mode, key in (("timelinetone", "news_tone"), ("timelinevolraw", "news_volume")):
                pts = _gdelt_timeline(topic, mode, weeks)
                if pts:
                    agg = [[] for _ in range(weeks)]
                    for d, v in pts:
                        b = _bucket(wins, d)
                        if b is not None:
                            agg[b].append(v)
                    t[key] = [round(_mean(a), 2) if a and key == "news_tone" else (round(sum(a)) if a else None) for a in agg]
                    out["sources"]["GDELT"] = True
        if external and "hn" in VIBES_EXTERNAL:
            hn = _hn_weekly(topic, wins)
            if hn:
                t["hn"] = [h["stories"] for h in hn]
                t["hn_points"] = [h["points"] for h in hn]
                out["sources"]["Hacker News"] = True
        t["shift"] = {
            "you_tone": _shift(t["tone"], "tone"),
            "you_saves": _shift(t["saves"], "count"),
            "news_tone": _shift(t["news_tone"], "news") if t["news_tone"] else None,
            "news_volume": _shift(t["news_volume"], "count") if t["news_volume"] else None,
            "hn": _shift(t["hn"], "count") if t["hn"] else None,
        }
        t["claims"] = [c for c in claims if _matches(topic, c["words"] | _words(_headline(next(
            (it for it in mine if it["id"] == c["item"]), {"title": ""}))))][-6:]
        t["what"] = _what_moved(t)
        out["topics"].append(t)
    out["drifts"] = [{"about": g["about"], "claims": [{k: c[k] for k in ("id", "item", "date", "source", "text", "raw", "value", "unit")}
                                                       for c in g["claims"]]} for g in number_drifts(claims)]
    for t in out["topics"]:
        for c in t["claims"]:
            c.pop("words", None)
    return out


def _what_moved(t: dict) -> str:
    s, bits = t["shift"], []
    if s["you_tone"] and s["you_tone"]["label"] != "Steady":
        bits.append(f"your feed got {'warmer' if s['you_tone']['delta'] > 0 else 'colder'} "
                    f"(tone {s['you_tone']['before']:+} to {s['you_tone']['now']:+})")
    if s["news_tone"] and s["news_tone"]["label"] != "Steady":
        bits.append(f"news tone {'rose' if s['news_tone']['delta'] > 0 else 'fell'} "
                    f"({s['news_tone']['before']:+} to {s['news_tone']['now']:+})")
    if s["news_volume"] and s["news_volume"]["label"] in ("Louder", "Quieter") and s["news_volume"]["ratio"]:
        bits.append(f"news volume {s['news_volume']['ratio']}x the weeks before")
    if s["hn"] and s["hn"]["label"] in ("Louder", "Quieter") and s["hn"]["ratio"]:
        bits.append(f"Hacker News stories {s['hn']['ratio']}x the weeks before")
    if s["you_saves"] and s["you_saves"]["label"] in ("Louder", "Quieter", "New"):
        bits.append(f"you saved {s['you_saves']['now']} a week, {s['you_saves']['before']} before")
    vr, vb = t["vibes_recent"], t["vibes_before"]
    if vr and vb:
        top_r, top_b = max(vr, key=vr.get), max(vb, key=vb.get)
        if top_r != top_b:
            bits.append(f"the main mood went from {top_b} to {top_r}")
    gap = _bubble_gap(t)
    if gap:
        bits.append(gap)
    if not bits:
        return "No clear change yet."
    text = "; ".join(bits) + "."
    return text[0].upper() + text[1:]


def _bubble_gap(t: dict):
    a, b = t["shift"].get("you_tone"), t["shift"].get("news_tone")
    if a and b and a["label"] != "Steady" and b["label"] != "Steady" and a["label"] != b["label"]:
        return f"your feed is {a['label'].lower()} while the news is {b['label'].lower()}"
    return None


def vibe_findings(vibes: dict) -> tuple[list[dict], dict]:
    """Findings + pieces (vibe:<slug>, claim:<id>) for the angle engine."""
    found, pieces = [], {}
    today = vibes["weeks"][-1] if vibes.get("weeks") else datetime.now().date().isoformat()
    for t in vibes.get("topics", []):
        ref = f"vibe:{t['slug']}"
        pieces[ref] = {"ref": ref, "type": "vibe", "date": today, "this_week": True, "kind": None,
                       "label": f"Vibe · {t['topic']}", "title": t["topic"], "text": t["what"], "words": set()}
        for c in t["claims"]:
            cref = f"claim:{c['id']}"
            pieces[cref] = {"ref": cref, "type": "claim", "date": c["date"], "this_week": True, "kind": None,
                            "item": c["item"], "label": f"Number · {c['source']} · {_fmt_date(c['date'])}",
                            "title": c["raw"], "text": c["text"], "words": set()}
        s = t["shift"]
        moved = [k for k, v in s.items() if v and v["label"] not in ("Steady",)]
        if _bubble_gap(t):
            found.append({"kind": "Bubble gap", "refs": [ref], "shared": [], "why": f"{t['topic']}: {_bubble_gap(t)}"})
        elif moved:
            found.append({"kind": "Vibe shift", "refs": [ref] + [f"claim:{c['id']}" for c in t["claims"][-1:]],
                          "shared": [], "why": f"{t['topic']}: {t['what']}"})
    for g in vibes.get("drifts", []):
        refs = []
        for c in g["claims"][:4]:
            cref = f"claim:{c['id']}"
            refs.append(cref)
            pieces.setdefault(cref, {"ref": cref, "type": "claim", "date": c["date"], "this_week": True, "kind": None,
                                     "item": c["item"], "label": f"Number · {c['source']} · {_fmt_date(c['date'])}",
                                     "title": c["raw"], "text": c["text"], "words": set()})
        vals = " then ".join(f"{c['raw']} ({_fmt_date(c['date'])})" for c in g["claims"][:4])
        found.append({"kind": "Number drift", "refs": refs, "shared": [], "why": f"numbers about '{g['about']}': {vals}"})
    return found, pieces


# ---- e-ink sparklines: one ink, one measure per chart, hover shows the value ----

def _spark(values: list, weeks: list, label: str, fmt=lambda v: f"{v}", zero: bool = False) -> str:
    W, H, P = 168, 46, 5
    pts = [(i, v) for i, v in enumerate(values or []) if v is not None]
    if len(pts) < 2:
        return (f"<figure class='spark'><figcaption>{esc(label)}</figcaption>"
                "<div class='spark-none'>No data</div></figure>")
    lo, hi = min(v for _, v in pts), max(v for _, v in pts)
    if zero:
        lo, hi = min(lo, 0), max(hi, 0)
    if hi == lo:
        hi, lo = hi + 1, lo - 1
    n = max(1, len(values) - 1)
    X = lambda i: P + (W - 2 * P) * i / n
    Y = lambda v: H - P - (H - 2 * P) * (v - lo) / (hi - lo)
    path = " ".join(f"{X(i):.1f},{Y(v):.1f}" for i, v in pts)
    base = (f"<line x1='{P}' x2='{W - P}' y1='{Y(0):.1f}' y2='{Y(0):.1f}' class='zero'/>" if zero and lo < 0 < hi else "")
    hits = "".join(
        f"<g class='pt'><rect x='{X(i) - (W - 2 * P) / n / 2:.1f}' y='0' width='{(W - 2 * P) / n:.1f}' height='{H}'/>"
        f"<circle cx='{X(i):.1f}' cy='{Y(v):.1f}' r='4'/>"
        f"<title>Week of {esc(_fmt_date(weeks[i]))}: {esc(fmt(v))}</title></g>" for i, v in pts)
    last_i, last_v = pts[-1]
    return (f"<figure class='spark'><figcaption>{esc(label)} <b>{esc(fmt(last_v))}</b></figcaption>"
            f"<svg viewBox='0 0 {W} {H}' role='img' aria-label='{esc(label)}, last {esc(fmt(last_v))}'>{base}"
            f"<polyline points='{path}'/><circle class='last' cx='{X(last_i):.1f}' cy='{Y(last_v):.1f}' r='4'/>{hits}</svg>"
            "</figure>")


def _vibes_html(v: dict, up: str) -> str:
    if not v or not v.get("topics"):
        return ("<p class='nb-empty'>No topics yet. Save a few more posts, or set WATCH_TOPICS in .env.</p>")
    weeks = v["weeks"]
    cards = []
    for t in v["topics"]:
        s = t["shift"]
        chips = []
        if s.get("you_tone"):
            chips.append(f"Your feed: {s['you_tone']['label']}")
        if s.get("news_tone"):
            chips.append(f"News mood: {s['news_tone']['label']}")
        loud = s.get("news_volume") or s.get("hn")
        if loud:
            chips.append(f"Noise: {loud['label']}")
        if _bubble_gap(t):
            chips.append("Bubble gap")
        sparks = (_spark(t["tone"], weeks, "Your feed tone", lambda x: f"{x:+.2f}", zero=True)
                  + _spark(t.get("news_tone"), weeks, "News tone", lambda x: f"{x:+.1f}", zero=True)
                  + _spark(t.get("news_volume"), weeks, "News articles", lambda x: f"{int(x):,}")
                  + _spark(t.get("hn"), weeks, "Hacker News stories", lambda x: f"{int(x):,}"))
        moods = ""
        if t["vibes_recent"] or t["vibes_before"]:
            f = lambda d: ", ".join(f"{n} {k}" for k, n in sorted(d.items(), key=lambda kv: -kv[1])) or "none"
            moods = f"<p class='byline'>Mood of what you saved · last 2 weeks: {esc(f(t['vibes_recent']))} · before: {esc(f(t['vibes_before']))}</p>"
        nums = "".join(
            f"<li><b>{esc(c['raw'])}</b> “{esc(c['text'])}” <span class='nb-meta'>{esc(_fmt_date(c['date']))} · "
            f"<a href='{up}item/{esc(c['item'])}.html'>{esc(c['source'])}</a></span></li>" for c in reversed(t["claims"]))
        cell = lambda xs, i, f=str: "" if not xs or xs[i] is None else f(xs[i])
        rows = "".join(
            f"<tr><td>{esc(_fmt_date(w))}</td><td>{t['saves'][i]}</td><td>{t['notes'][i]}</td>"
            f"<td>{cell(t['tone'], i, lambda x: f'{x:+.2f}')}</td>"
            f"<td>{cell(t.get('news_tone'), i)}</td><td>{cell(t.get('news_volume'), i)}</td>"
            f"<td>{cell(t.get('hn'), i)}</td></tr>" for i, w in enumerate(weeks))
        cards.append(
            f"<article class='vibe' id='vibe-{esc(t['slug'])}'>"
            f"<div class='angle-top'><h3>{esc(t['topic'])}</h3><span class='byline'>{sum(t['saves'])} saves · {sum(t['notes'])} notes</span></div>"
            + (f"<div class='chips static'>{''.join(f'<span>{esc(c)}</span>' for c in chips)}</div>" if chips else "")
            + f"<p class='connection'>{esc(t['what'])}</p>"
            + f"<div class='sparks'>{sparks}</div>" + moods
            + (f"<h4>Numbers in circulation</h4><ul class='material'>{nums}</ul>" if nums else "")
            + "<details><summary class='byline'>See the numbers</summary><div class='tablewrap'><table>"
              "<thead><tr><th>Week of</th><th>Saves</th><th>Notes</th><th>Your tone</th><th>News tone</th>"
              f"<th>News articles</th><th>HN stories</th></tr></thead><tbody>{rows}</tbody></table></div></details>"
            "</article>")
    drift = ""
    if v.get("drifts"):
        items_ = "".join(
            f"<li><b>{esc(g['about'] or 'Same metric')}</b>: "
            + " → ".join(f"{esc(c['raw'])} <span class='nb-meta'>({esc(_fmt_date(c['date']))}, "
                         f"<a href='{up}item/{esc(c['item'])}.html'>{esc(c['source'])}</a>)</span>" for c in g["claims"])
            + "</li>" for g in v["drifts"])
        drift = f"<h2 class='section-head'>Number drift</h2><ul class='material'>{items_}</ul>"
    src = ", ".join(["your saves"] + list(v.get("sources", {}).keys()))
    return (f"<p class='nb-sub'>Sources: {esc(src)}. Last {len(weeks)} weeks. Tone runs from -1 to +1 for your feed; "
            "GDELT news tone uses its own wider scale. Hover a point for its value.</p>"
            f"<div class='vibes'>{''.join(cards)}</div>{drift}")


def cmd_weekly(args) -> None:
    notes = pull_notes()
    drafts = pull_drafts()
    items = _load_items()
    today = datetime.now().date()
    days = max(1, args.days)
    start, end = (today - timedelta(days=days - 1)).isoformat(), today.isoformat()
    st = week_stats(items, notes, start, end)
    st["ratio_history"] = ratio_history(items, notes, today, days)
    llm = make_llm()
    print("Reading the mood…")
    vibes = build_vibes(items, notes, today, llm, external=not args.offline)
    pieces = _material(items, notes, start, end)
    found = find_links(pieces, st, notes, items, start, end)
    v_found, v_pieces = vibe_findings(vibes)
    pieces.update(v_pieces)
    found = _diverse(v_found + found)[:14]
    flat = _flat_stats(st)
    angles = pitch_angles(found, pieces, st, llm, _used_angles(drafts))
    check_angles(angles, pieces, flat)
    resolve_material(angles, pieces, flat)
    label = _week_label(today)
    wk_notes = [n for ed in sorted(notes) if start <= ed <= end for n in notes[ed]]
    save_json(WEEKLY / f"{label}.json", {"label": label, "stats": st, "notes": wk_notes,
                                          "links": found, "angles": angles, "vibes": vibes,
                                          "created_at": now_iso()})
    for t in vibes["topics"]:
        print(f"  {t['topic']}: {t['what']}")
    print(f"\n{len(found)} link(s) found, {len(angles)} angle(s) pitched for {label}:\n")
    for a in angles:
        print(f"  [{a['type']}] {a['title']}\n    {a['turn']}\n    evidence: {', '.join(a['evidence'])}"
              + (f"\n    ! {a['check']}" if a.get("check") else "") + "\n")
    build_site()
    if args.deploy:
        cmd_deploy(args)


def _angle_card(a: dict, up: str) -> str:
    mat = []
    for m in a.get("material", []):
        if m["kind"] == "stat":
            mat.append(f"<li><span class='nb-kind'>Data</span>{esc(m['label'])}: <b>{esc(m['text'])}</b></li>")
        elif m["kind"] == "story":
            mat.append(f"<li><span class='nb-kind'>Story</span><a href='{up}item/{esc(m['item'])}.html'>{esc(m['title'])}</a></li>")
        elif m["kind"] == "vibe":
            mat.append(f"<li><span class='nb-kind'>Vibe</span><a href='#vibe-{_slug(m['title'])}'>{esc(m['title'])}</a>: {esc(m['text'])}</li>")
        elif m["kind"] == "claim":
            mat.append(f"<li><span class='nb-kind'>Number</span><b>{esc(m['title'])}</b> “{esc(m['text'])}”"
                       f"<span class='nb-meta'>{esc(m['label'].split(' · ', 1)[-1])}</span></li>")
        else:
            ref = (f" <a class='nb-meta' href='{up}item/{esc(m['item'])}.html'>re: {esc(m['title'] or 'story')}</a>"
                   if m.get("item") else "")
            mat.append(f"<li><span class='nb-kind'>{esc(m['label'].split(' · ')[1] if ' · ' in m['label'] else 'Note')}</span>"
                       f"“{esc(m['text'])}”<span class='nb-meta'>{esc(m['label'].split(' · ')[-1])}</span>{ref}</li>")
    fits = " · ".join({"linkedin": "LinkedIn", "x": "X"}[f] for f in a.get("fits", []))
    return (f"<article class='angle' id='{esc(a['id'])}'>"
            f"<div class='angle-top'><span class='kicker'>{esc(a['type'])}</span><span class='byline'>{esc(fits)}</span></div>"
            f"<h3>{esc(a['title'])}</h3>"
            f"<p class='connection'>{esc(a['connection'])}</p>"
            + (f"<p class='turn'>{esc(a['turn'])}</p>" if a.get("turn") else "")
            + f"<h4>Your material</h4><ul class='material'>{''.join(mat)}</ul>"
            + (f"<p class='detail'><b>The true detail</b>{esc(a['true_detail'])}</p>" if a.get("true_detail") else "")
            + ("<h4>Start here</h4><ol class='prompts'>" + "".join(f"<li>{esc(p)}</li>" for p in a.get("prompts", [])) + "</ol>"
               if a.get("prompts") else "")
            + (f"<p class='avoid'><b>Avoid</b>{esc(a['avoid'])}</p>" if a.get("avoid") else "")
            + (f"<p class='err'>{esc(a['check'])}</p>" if a.get("check") else "")
            + f"<div class='links'><button type='button' class='btn primary' data-angle='{esc(a['id'])}'>Write this</button></div>"
            "</article>")


def _week_page(w: dict) -> str:
    up, st = "../", w["stats"]
    k = st["notes_by_kind"]
    hist = st.get("ratio_history") or []
    cells = [(st["bookmarks"], "Bookmarks"), (st["notes"], "Notes"), (k.get("changed", 0), "Changed my mind"),
             (st["notes_per_10_bookmarks"], "Notes per 10 saves"), (k.get("odd", 0), "Odd or funny"),
             (st["editions"], "Editions")]
    stats = "".join(f"<div class='stat'><b>{esc(v)}</b><span>{esc(lbl)}</span></div>" for v, lbl in cells)
    extra = []
    if hist:
        extra.append("Notes per 10 saves, earlier: " + ", ".join(f"{esc(_fmt_date(h['end']))}: {h['per10']}" for h in hist))
    if st["top_domains"]:
        extra.append("Top sources: " + ", ".join(f"{esc(d)} ({n})" for d, n in st["top_domains"]))
    if st["busiest_day"]:
        extra.append(f"Busiest day: {esc(st['busiest_day'])}")

    angles = w.get("angles") or []
    cards = "".join(_angle_card(a, up) for a in angles) or (
        "<p class='nb-empty'>No angles yet. Log a few notes this week, then run <code>weekly</code>.</p>")
    seed = [{"id": a["id"], "type": a["type"], "title": a["title"], "turn": a.get("turn", ""),
             "prompts": a.get("prompts", []), "material": a.get("material", [])} for a in angles]
    pad = (
        f"<section class='pad' id='pad' data-week='{esc(w['label'])}' data-up='{up}'>"
        "<div class='pad-side'><div class='kicker'>Writing from</div>"
        "<h3 class='pad-title'>Pick an angle above, or write freely.</h3>"
        "<p class='turn pad-turn' hidden></p>"
        "<ul class='material pad-material'></ul><ol class='prompts pad-prompts'></ol></div>"
        "<div class='pad-main'>"
        "<div class='nb-head'><h2>LinkedIn</h2><span class='nb-status' data-count-for='d-li'></span></div>"
        "<label class='sr' for='d-li'>Your LinkedIn post</label>"
        "<textarea id='d-li' data-draft placeholder='Start with the true detail. Say what you saw.'></textarea>"
        "<div class='links'><button type='button' class='btn primary' data-copy='d-li'>Copy</button>"
        "<a class='btn' data-share-link='d-li' data-base='https://www.linkedin.com/feed/?shareActive=true&amp;text=' "
        "href='https://www.linkedin.com/feed/'>Open LinkedIn</a>"
        "<label class='btn posted'><input type='checkbox' data-posted='linkedin'> Posted</label></div>"
        f"<div class='nb-head' style='margin-top:22px'><h2>X</h2><span class='nb-status' data-count-for='d-x' data-limit='280'></span></div>"
        "<label class='sr' for='d-x'>Your X post</label>"
        "<textarea id='d-x' data-draft class='short' placeholder='One idea. The turn, in your words.'></textarea>"
        "<div class='links'><button type='button' class='btn primary' data-copy='d-x'>Copy</button>"
        "<a class='btn' data-share-link='d-x' data-base='https://x.com/intent/post?text=' href='https://x.com/compose/post'>Post on X</a>"
        "<label class='btn posted'><input type='checkbox' data-posted='x'> Posted</label></div>"
        "<p class='nb-status pad-status' role='status'></p></div>"
        f"<script type='application/json' class='nb-seed'>{_json_embed(seed)}</script></section>")

    notes_html = "".join(
        f"<li class='nb-note'><span class='nb-kind'>{esc(NOTE_KINDS.get(n.get('kind'), 'Note'))}</span>{esc(n.get('text'))}"
        + (f"<span class='nb-meta'>re: <a href='{up}item/{esc(n['item'])}.html'>{esc(n.get('itemTitle') or 'story')}</a></span>"
           if n.get("item") else "") + "</li>"
        for n in w.get("notes", [])) or "<li class='nb-empty'>No notebook entries this week.</li>"
    end_d = datetime.fromisoformat(st["end"])
    body = (_masthead(up, "The angle desk", esc(w["label"]),
                      f"<span>Week {esc(w['label'][-2:])}</span><span>{esc(_fmt_date(st['start']))} to {esc(_fmt_date(st['end']))}</span>"
                      f"<span><a href='{up}archive.html'>Archive</a> · <a href='{up}notebook.html'>Notebook</a></span>", mini=True)
            + "<h2 class='section-head'>By the numbers</h2>"
            + f"<div class='stats'>{stats}</div>"
            + (f"<p class='byline' style='margin-top:12px'>{' · '.join(extra)}</p>" if extra else "")
            + "<h2 class='section-head'>Vibes and numbers</h2>" + _vibes_html(w.get("vibes") or {}, up)
            + "<h2 class='section-head'>Angles</h2>"
            + "<p class='nb-sub'>Links found in your own reading and notes. Each one shows its evidence. "
              "You write the post. Nothing posts by itself.</p>"
            + f"<div class='angles'>{cards}</div>"
            + "<h2 class='section-head'>Your desk</h2>" + pad
            + "<h2 class='section-head'>What you wrote down this week</h2>"
            + f"<ol class='nb-list'>{notes_html}</ol>"
            + f"<footer class='foot'><a href='{up}index.html'>Today's edition</a><a href='{up}archive.html'>All editions</a>"
            + f"<span>{esc(f'{end_d:%B} {end_d.day}')}</span></footer>")
    return _doc(f"{SITE_TITLE} · Angles · {w['label']}", up, body)


# ---------- deploy (Cloudflare Pages + Functions + KV, all free tier) ----------

def write_cf_files() -> None:
    api = ROOT / "functions" / "api"
    api.mkdir(parents=True, exist_ok=True)
    (api / "notes.js").write_text(NOTES_FUNCTION_JS)
    (api / "drafts.js").write_text(DRAFTS_FUNCTION_JS)
    toml = ROOT / "wrangler.toml"
    if CF_KV_NOTES_ID and (not toml.exists() or "managed by x_reader" in toml.read_text()):
        toml.write_text(
            "# managed by x_reader.py\n"
            f'name = "{CF_PROJECT}"\n'
            'pages_build_output_dir = "./site"\n'
            'compatibility_date = "2026-06-01"\n\n'
            "[[kv_namespaces]]\n"
            'binding = "NOTES"\n'
            f'id = "{CF_KV_NOTES_ID}"\n')
    elif not CF_KV_NOTES_ID:
        print("  CF_KV_NOTES_ID not set: notebook saves on each device only")


def cmd_deploy(_args) -> None:
    if not CF_PROJECT:
        die("set CF_PAGES_PROJECT in .env")
    if not (SITE / "index.html").exists():
        build_site()
    write_cf_files()
    subprocess.run(["npx", "--yes", "wrangler", "pages", "deploy", "site",
                    "--project-name", CF_PROJECT, "--branch", "main", "--commit-dirty=true"],
                   cwd=ROOT, check=True)


def cmd_run(args) -> None:
    cmd_sync(args)
    cmd_deploy(args)


def main() -> None:
    ap = argparse.ArgumentParser(description="X bookmarks -> a daily newspaper with a notebook")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("login").set_defaults(fn=cmd_login)
    for name, fn in (("sync", cmd_sync), ("run", cmd_run)):
        p = sub.add_parser(name)
        p.add_argument("--limit", type=int, default=None, help="max new bookmarks to process")
        p.add_argument("--full", action="store_true", help="scroll through all bookmarks")
        p.add_argument("--no-push", action="store_true", help="do not send new bookmarks to Trendwire")
        p.set_defaults(fn=fn)
    p = sub.add_parser("push", help="send bookmarks not yet sent to Trendwire")
    p.add_argument("--limit", type=int, default=None, help=f"most to send (default {TRENDWIRE_PUSH_LIMIT})")
    p.add_argument("--backfill", type=int, default=None, help="send the newest N unsent, including old ones")
    p.add_argument("--dry-run", action="store_true", help="list what would be sent; send nothing")
    p.set_defaults(fn=cmd_push)
    sub.add_parser("build").set_defaults(fn=cmd_build)
    sub.add_parser("deploy").set_defaults(fn=cmd_deploy)
    sub.add_parser("pull-notes").set_defaults(fn=cmd_pull_notes)
    for name in ("weekly", "angles"):
        p = sub.add_parser(name, help="find links in your notes and reading, pitch angles for you to write")
        p.add_argument("--days", type=int, default=7, help="how many days back to look (default 7)")
        p.add_argument("--deploy", action="store_true", help="deploy the site after")
        p.add_argument("--offline", action="store_true", help="skip GDELT and Hacker News; use only your feed")
        p.set_defaults(fn=cmd_weekly)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
