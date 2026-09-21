# Trendwire

A daily technology digest that runs in the cloud, reads what the industry actually argued about, and never asks you to open X.

Ingests Hacker News, Lobsters, GitHub, arXiv, Hugging Face papers, trade press, Techmeme, Reddit, Bluesky and the open-web reflection of X into Postgres, clusters the last 24 hours into named themes, tracks a dedicated people-moves beat, and publishes a dated issue with a permanent archive.

**Stack:** Next.js (App Router) on Vercel · Postgres via Drizzle · Vercel Cron

**Operator’s magazine (offline):** open [`magazine.html`](./magazine.html). Vol. 2 is an argument about the architecture, not a restatement of this README. Print or Save as PDF from the browser.

---

## How it works

```
Vercel Cron (daily)  ──►  /api/cron/digest ──┐
GitHub Actions tick  ──►  /api/tick        ──┤
                                             ▼
                                  acquire lease (Postgres)
                                  ingest pending sources
                                  synthesize → publish
                                  release lease
```

One invocation does as much as it can inside a 240s internal budget (the platform
ceiling is 300s on every plan) and returns a report. If it runs out of budget it
stops cleanly; the next tick reads the run log, sees what's already done, and
continues. Both routes call the same `advance()`, which is idempotent and safe to
call concurrently.

There is deliberately **no self-invocation**. An earlier version had each chunk
re-invoke the next over HTTP; Vercel can freeze a function's execution context as
soon as it responds, so an un-awaited `fetch` may never leave the box and the
chain dies silently mid-run. Doing the work inline has no such failure mode.

See **[DEPLOY.md](./DEPLOY.md)** for the full cloud rationale and deployment steps.

### Pipeline stages

1. **Ingest** — each source adapter normalizes into `raw_items`. Adapters never throw into the runner; every outcome (`ok` / `empty` / `failed` / `skipped`) is written to `run_sources`.
2. **Dedup** — canonical URL plus content hash collapse the same story arriving from several sources. Corroboration count is retained, because being carried by four sources is itself a signal.
3. **Synthesize** — the top 60 deduped items go to one LLM call (Gemini, OpenRouter, Anthropic, or OpenAI) returning themes and people moves as JSON. Item indexes are mapped back to real row ids; enum fields are validated.
4. **Publish** — the digest flips to `published`. Pages read from Postgres and never re-fetch sources.

### Sources

| Tier | Sources |
|---|---|
| Core (open APIs + trade press) | Hacker News stories, HN top comments, Lobsters, GitHub new+rising, arXiv cs.AI/LG/CL, Hugging Face daily papers, Ars Technica, 404 Media, TechCrunch, The Register, MIT Technology Review |
| X-adjacent | Techmeme, Reddit, Exa semantic search scoped to x.com, X mirror frontends, Bluesky watched accounts, Simon Willison, Import AI, Latent Space, Platformer, Interconnects, Hugging Face blog, OpenAI News, The Verge |
| People beat | HN personnel headlines, Techmeme personnel headlines, Exa people-move search |
| Saved | Tweets you bookmark (bookmarklet, shortcut, or native X bookmarks), plus every outbound link and image on them |

**On the X tier:** no single path is load-bearing. Mirror instances die constantly and Exa needs a key; when those go dark, Techmeme, Bluesky, and the newsletters still carry the conversation secondhand with a few hours' lag. Every source reports its own status, so degradation is visible on the page rather than silent.

**Saving a tweet:** open `/save`, generate a bookmarklet, and click it on a tweet. Trendwire fetches the post (via FxTwitter, no X API key required), stores the text, every outbound link, and every image, and gives those items guaranteed seats in the next issue. Native X bookmarks can feed the same path if you set `X_BOOKMARKS_TOKEN` and `X_USER_ID`.

---

## Deploy

Full instructions, including the platform constraints that shaped the design, are
in **[DEPLOY.md](./DEPLOY.md)**. The short version:

```bash
npx vercel                 # deploy
# set DATABASE_URL, CRON_SECRET, and GEMINI_API_KEY or OPENROUTER_API_KEY in Vercel
npm run db:migrate         # apply schema via the DIRECT connection (port 5432)
npx vercel --prod
curl -H "Authorization: Bearer $CRON_SECRET" https://<you>.vercel.app/api/cron/digest
curl https://<you>.vercel.app/api/status
```

Postgres comes from **Supabase**. You need two connection strings: the
transaction pooler (port 6543) for the app, the direct connection (port 5432)
for migrations. DEPLOY.md explains why. This app does not use Auth, Realtime,
or the Supabase JS client — only Postgres.

## Local development

There is no Postgres requirement for local work. The harness uses [PGlite](https://pglite.dev) — real Postgres compiled to WASM — so the full pipeline runs against live sources with no server:

```bash
npm run digest:local
```

This applies migrations, ingests everything, synthesizes, and prints the digest plus a per-source health report:

```
  ✓ hackernews             45 items  892ms
  ✓ arxiv                  40 items  1204ms
  · reddit                  0 items  2100ms — all subreddits unreachable (403)
```

To browse the result:

```bash
DATABASE_URL="pglite://./.pglite" npm run build && DATABASE_URL="pglite://./.pglite" npm start
```

### Tests

```bash
npm test
```

Five suites. Lock, adapter, continuity, synthesis, and bookmarks need no network. Resume drives the real adapters (live HTTP) under a 1ms budget:

- **`test-lock.ts`** — the lease lock: contention (exactly one of four concurrent acquires wins), non-holders can't renew or release, expired leases are stealable (the crash-recovery path), and the lease is freed even when the body throws.
- **`test-adapter.ts`** — unique source slugs, the new sources are registered, and `withTimeout` actually cuts off a hung fetch.
- **`test-resume.ts`** — resumability: drives the pipeline with a 1ms budget so it's forced to stop repeatedly, then asserts every source was ingested **exactly once** across resumes, synthesis ran once rather than per pass, and a tick after publication is a no-op.
- **`test-synthesis.ts`** — the model path against a stub provider: prompt assembly, fenced-JSON recovery, item-index → row-id mapping, invalid enum coercion, out-of-range indexes, and fallback when no key is set.
- **`test-bookmarks.ts`** — tweet URL parsing, unpacking links and images from FxTwitter/vxTwitter payloads, ingest item shape, and corpus seats for saved tweets.

---

## Routes

| Route | Purpose |
|---|---|
| `/` | Latest published issue |
| `/digest/2026-08-17` | A specific date |
| `/archive` | Every issue |
| `/api/digest/latest`, `/api/digest/:date` | JSON |
| `/feed.xml` | RSS |
| `/save` | Bookmarklet to save a tweet (links + images) into the next issue |
| `/api/bookmark` | Capture a tweet URL (auth required) |
| `/api/game-feed/:date` | Flat, ranked projection for downstream games |
| `/api/status` | Operational health; 503 when degraded |
| `/api/cron/digest` | Daily pipeline entry point (auth required) |
| `/api/tick` | Idempotent resume; `?date=` for backfills (auth required) |

---

## Feeding a game

`/api/game-feed/:date` is a narrow projection of an issue for consumers that are
not a reader: ranked five-letter terms each carrying the verbatim headline it
came from, the organizations named that day, and the people beat.

It exists rather than having consumers parse `/api/digest/latest` because the
digest JSON is the *reading* shape — nested themes, their items, bookmarks,
source health — and because three rules have to hold in one place rather than
being reimplemented downstream:

- **A term is only returned if some row can be quoted as its brief.** A game
  that cannot show a player where a word came from should not use the word.
- **Only `confirmed` people moves are emitted.** A quiz asserts, and `reported`
  and `chatter` are not assertions. Wire editions grade their heuristic moves
  `chatter`, so the beat empties itself exactly when no editor vouched for it.
- **Nothing in the output is generated prose.** Every string is copied from a
  row, which is what stops a downstream game inventing the news.

Fetch by date, not `latest` — consumers commit snapshots and need reproducible
builds. The archive makes that free. Unpublished dates return 409 rather than a
thin corpus that would read as a quiet news day.

Two consumers today, both in `../../Claude/Calude_Code_game_ai`: **fiver** picks
the day's word puzzle by overlap with `terms` and quotes one `brief`;
**front-door** builds a question out of `moves` and flags companies named in
`orgs`.

## Known limitations

Being straight about the edges rather than discovering them in production:

- **Reddit 403s from datacenter IPs.** Unauthenticated `.json` reads are blocked from most cloud hosts, including Vercel. Set `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` (a script app at reddit.com/prefs/apps) to use application-only OAuth. Without them the source reports `skipped`.
- **GitHub search 403s from Vercel without a token.** Set `GITHUB_TOKEN` (public-repo read is enough). Without it the source reports `skipped` rather than failing the day.
- **X mirror instances are unreliable by nature.** The adapter races a list and skips when all are down. This is expected, not a bug — it's why the X tier has three independent paths.
- **arXiv doesn't publish on weekends.** That source uses a 96-hour lookback instead of 24 so Saturday and Sunday issues aren't empty; dedup absorbs the overlap.
- **The wire fallback is deliberately not editorial.** Without an LLM key, or when the call fails, the issue publishes as a ranked intake list labeled "wire edition" — not heuristic term clusters pretending to be themes.
- **One LLM call per day** caps cost but also caps nuance; the corpus is trimmed to the top 60 deduped items, with the people beat and saved tweets guaranteed representation so a busy AI news day can't crowd them out.
- **No email delivery yet.** RSS is wired; adding Resend on publish is a small addition to the synthesis step.
- **The game feed's org list is partly heuristic.** Names from the people beat
  are the editor's; the rest are capitalized runs parsed out of headlines, which
  picks up the occasional person or common noun. Each entry carries `fromBeat`
  so a consumer can weight it, and a consumer matching against its own dataset
  should match exactly rather than fuzzily.
- **Supabase Free projects can pause after a week of inactivity.** A daily cron keeps this one awake. Page caching keeps most visits off the database.
- **Synthesis corpus is capped at 60 items** because a 120-item prompt did not return within 10 minutes against a live model, which on Vercel means the run is killed. Raise `SYNTH_MAX_CORPUS` only alongside `LLM_TIMEOUT_MS`, and measure.

## Cost

One cron run and one LLM call per day, plus a Postgres instance that fits comfortably in a free tier at this volume. `raw_items` is the only table that grows meaningfully — add a retention prune if the archive gets long.
