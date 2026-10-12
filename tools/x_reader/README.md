# x_reader

Reads your X bookmarks without the X API, and does two things with them:

1. **Builds a private reading site.** Each bookmark's link becomes a PDF and a
   short summary, set as a small daily newspaper with a notebook, a weekly
   "angle desk" and a mood-and-numbers tracker. This is the original script,
   unchanged.
2. **Feeds Trendwire.** New bookmarks are sent to Trendwire's `/api/bookmark`,
   which gives each one a guaranteed seat in the next issue, with the links and
   images it carries. *This is the part added for Trendwire.*

It runs on your machine, not on Vercel: it drives a real Chromium signed in as
you, and the summaries come from a local Ollama (or an Anthropic key).

## Why this exists

Trendwire already had two ways to save a tweet: the `/save` bookmarklet, and the
native X bookmarks API (`X_BOOKMARKS_TOKEN`), which needs a paid API tier. This
is a third: your ordinary bookmarks, read through the web app you are already
signed in to, with no API key.

```
x.com/i/bookmarks ──► x_reader.py ──► tweet URL ──► POST /api/bookmark ──► next issue
   (your session)      (this machine)               (Trendwire, FxTwitter)
```

Trendwire does its own fetching of the tweet, so the only thing sent is the URL.

## Setup

```bash
cd tools/x_reader
cp .env.example .env            # then fill in what you need
uv run x_reader.py login        # sign in to X once, in a visible browser
uv run x_reader.py sync         # fetch new bookmarks, build site/, push to Trendwire
```

`uv` reads the dependency list from the script's header. Without it:
`pip install httpx playwright trafilatura pypdf python-dotenv`, then
`python3 x_reader.py …` on Python 3.11 or newer.

To send to Trendwire, set `TRENDWIRE_URL` and `TRENDWIRE_BOOKMARK_SECRET` in
`.env`. Leave `TRENDWIRE_URL` empty and nothing about `sync` changes.

## What gets sent, and when

- **Only new bookmarks.** The first run with `TRENDWIRE_URL` set records every
  bookmark you already have as "sent" and sends none of them. Trendwire files a
  bookmark under the day it arrives, so an old archive pushed in one go would
  land entirely in a single issue.
- **At most 15 per run** (`TRENDWIRE_PUSH_LIMIT`, or `push --limit N`). The rest
  wait for the next run.
- **Each bookmark once.** A bookmark that fails is retried on later runs; one
  that fails three times (usually a deleted or protected tweet) is given up on
  so it cannot use up the cap every day. Re-sending is harmless on Trendwire's
  side either way.
- **A push problem never breaks a sync.** If Trendwire is down, the site still
  builds and the bookmarks go out next time.

```bash
uv run x_reader.py push --dry-run      # list what would be sent
uv run x_reader.py push                # send now
uv run x_reader.py push --backfill 25  # also send the newest 25 old ones
uv run x_reader.py sync --no-push      # this once, do not send
```

Push state lives in `xreader_data/push_state.json`, separate from the script's
own `state.json`.

## What stays local

`xreader_data/` holds your signed-in X session (`browser_profile/`), your saved
items and notes. `.env` holds your X cookies. `site/` is the generated site.
All of it is git-ignored; do not commit any of it.

The script's own header notes that automated access to X is against X's terms,
and recommends one run a day. That risk is yours to weigh; nothing here makes
more requests than `sync` already did.

## Tests

```bash
python3 tools/x_reader/test_push.py
```

Runs the push logic against a local stub server (no network, no X): the
baseline, the cap, a rejected secret, an unreadable tweet, a tweet that keeps
failing, and Trendwire being down.
