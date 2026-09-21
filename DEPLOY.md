# Deploying Trendwire

Target: a daily digest that runs unattended in the cloud, on free tiers, with no laptop involved.

Total time: ~15 minutes. You need a GitHub account, a Vercel account, and a Supabase account.

---

## The cloud architecture, and why it looks like this

Three platform constraints shape the whole design. They're worth understanding before you deploy, because they explain choices that would otherwise look arbitrary.

**1. Vercel freezes your function after it responds.**
Vercel's own docs are explicit: if a handler returns a response while an async task is still running without `await`, "the Function may send its response and freeze its execution context before the task is finished." An earlier version of this service had the cron kick off a worker that re-invoked itself over HTTP for each chunk of sources. That pattern silently dies mid-run in production. There is now **no self-invocation anywhere** — one invocation does as much as it can and returns a report.

**2. Hobby crons run once per day, and Vercel doesn't dedupe them.**
A more frequent cron expression *fails at deploy time* on Hobby, and the daily one fires anywhere within its scheduled hour. Vercel also documents that it will not prevent overlapping invocations — if a run outlasts its interval, you can get two. Hence two things: a **lease lock** in Postgres so only one run proceeds, and an idempotent **`/api/tick`** endpoint so an external scheduler can provide fast recovery.

**3. Every plan gets 300 seconds.**
Fluid compute (default since April 2025) raised the ceiling to 300s on Hobby too. A full run measures ~90s, so it fits comfortably in one invocation — which is why chunking-for-its-own-sake was removed. The pipeline still stops cleanly at a 240s internal budget and resumes on the next tick, so a slow day degrades instead of failing.

```
Vercel Cron (daily, 13:00 UTC)          GitHub Actions (every 15 min, optional)
        │                                            │
        └──────────► /api/cron/digest      /api/tick ◄┘
                            │                  │
                            └────────┬─────────┘
                                     ▼
                          acquire lease (Postgres)
                                     │
                          ingest pending sources
                          ────────────────────────
                          synthesize → publish
                                     │
                          release lease
```

Both routes call the same `advance()`. It reads what's already done from the run log, does the rest within its budget, and is safe to call at any time — including twice at once.

---

## Step 1 — Database (Supabase)

This app talks to Postgres over TCP with Drizzle. It does **not** use Supabase Auth, Realtime, Storage, or the JS client — only the database. You still need two connection strings, and they are not interchangeable — see the box below.

**Option A — create the project on Supabase (recommended).** Do this before or after Step 2.

1. Create a project at [supabase.com/dashboard](https://supabase.com/dashboard) (Free is enough). Pick a region near your users.
2. **Connect** → **Connection string** → **URI**. Copy **both**:
   - **Transaction pooler** (host `*.pooler.supabase.com`, port **6543**) → `DATABASE_URL`
   - **Direct** (`db.<project-ref>.supabase.co`, port **5432**) → `DIRECT_DATABASE_URL`
3. Use the URI method, not the Prisma connection string (`?pgbouncer=true`). postgres.js does not want that flag.

If migrate fails with `ENETUNREACH` / IPv6, the direct host is IPv6-only on some projects. Use the **Session** pooler instead (same `pooler.supabase.com` host, port **5432**) as `DIRECT_DATABASE_URL`. Do not migrate through port 6543.

**Option B — via the Vercel Marketplace.** After Step 2: Vercel → **Storage** → **Create Database** → **Supabase**. The integration sets `POSTGRES_URL` (pooled) and `POSTGRES_URL_NON_POOLING` (direct). The app and `npm run db:migrate` honor those names. You can also copy them to `DATABASE_URL` / `DIRECT_DATABASE_URL` if you prefer the names in `.env.example`.

> ### Why two connection strings
> Supabase's serverless URL is **Supavisor in transaction mode** (port 6543). It does not support `SET`/`RESET`, `LISTEN`/`NOTIFY`, SQL-level `PREPARE`, temporary tables, or **session-level advisory locks**.
>
> Two consequences in this codebase:
> - Migrations run against the **direct** string (`scripts/migrate.ts` prefers `POSTGRES_URL_NON_POOLING` / `DIRECT_DATABASE_URL` and warns if you point it at port 6543).
> - The run lock is a **lease row**, not `pg_advisory_lock`. A session lock taken through a transaction-mode pooler can outlive the logical connection that took it, which is a deadlock waiting to happen. The lease also self-heals: if a function is killed mid-run, the lease expires and the next tick continues.

## Step 2 — Deploy the app

```bash
git init && git add -A && git commit -m "Initial commit"
gh repo create trendwire --private --source=. --push   # or push to a repo you made in the UI

npx vercel            # link the project, accept the Next.js defaults
```

Don't visit the site yet — the schema doesn't exist.

## Step 3 — Environment variables

Vercel dashboard → **Settings → Environment Variables**. Set for **Production** (and Preview if you want previews to work):

| Variable | Required | Value |
|---|---|---|
| `DATABASE_URL` | yes | Transaction pooler URI (port **6543**). Marketplace equivalent: `POSTGRES_URL`. |
| `DIRECT_DATABASE_URL` | for migrate | Direct URI (port **5432**). Marketplace equivalent: `POSTGRES_URL_NON_POOLING`. |
| `CRON_SECRET` | yes | `openssl rand -hex 32`. Vercel sends it as `Authorization: Bearer …` on cron calls. |
| `GEMINI_API_KEY` or `OPENROUTER_API_KEY` or `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` | strongly recommended | Tried in that order. Without any, the digest publishes heuristic term clusters. |
| `LLM_PROVIDER` | optional | Pin a provider or chain, e.g. `gemini` or `gemini,openrouter`. |
| `NEXT_PUBLIC_SITE_URL` | recommended | Your final URL, e.g. `https://trendwire.vercel.app`. Used for RSS links and OpenRouter's HTTP-Referer. |
| `EXA_API_KEY` | optional | Enables X-scoped semantic search and the Exa people pass. Without it those two sources report `skipped`. |
| `GITHUB_TOKEN` | recommended | Public-repo PAT. Without it GitHub search often 403s from Vercel and reports `skipped`. |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` | recommended | Application-only OAuth. Without it Reddit reports `skipped` from datacenter IPs. |
| `BOOKMARK_SECRET` | optional | Auth for `/api/bookmark` and the `/save` bookmarklet. Falls back to `CRON_SECRET`. Prefer a separate value so a leaked bookmarklet cannot fire the pipeline. |
| `X_BOOKMARKS_TOKEN` / `X_USER_ID` | optional | Pull tweets you bookmark inside X. Token needs `bookmark.read`. |
| `GEMINI_MODEL` | optional | Defaults to `gemini-2.5-pro`. |
| `OPENROUTER_MODEL` | optional | Defaults to `google/gemini-2.5-pro`. |
| `ANTHROPIC_MODEL` | optional | Defaults to `claude-sonnet-4-5`. Some gateways require a dated id like `claude-sonnet-4-5-20250929`. |
| `SYNTH_MAX_CORPUS` | optional | Defaults to 60. See tuning note below. |
| `LLM_TIMEOUT_MS` | optional | Defaults to 120000. |

> **If `CRON_SECRET` is unset in production, both `/api/cron/digest` and `/api/tick` return 401.** That's deliberate — a misconfigured deploy fails closed rather than exposing a pipeline anyone can trigger.

## Step 4 — Create the schema

From your machine, with the **direct** connection string (port 5432):

```bash
cp .env.example .env
# fill in DIRECT_DATABASE_URL (and DATABASE_URL)
npm install
npm run db:migrate
```

This applies the versioned SQL in `drizzle/` and records it in `drizzle.__drizzle_migrations`, so it's safe to re-run and safe in CI. (`npm run db:push` also exists for rapid prototyping — it diffs and applies without migration files. Prefer `db:migrate` for anything you intend to keep.)

## Step 5 — Redeploy and trigger the first run

```bash
npx vercel --prod
```

`vercel.json` registers the cron; Vercel picks it up on deploy. Then trigger it manually rather than waiting until 13:00 UTC:

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  https://your-project.vercel.app/api/cron/digest | jq
```

Expect something like:

```json
{
  "ok": true,
  "date": "2026-08-18",
  "outcome": "synthesized",
  "sources": "28/28",
  "themes": 7,
  "people": 0,
  "items": 233,
  "provider": "anthropic",
  "elapsedMs": 84210,
  "failedSources": []
}
```

If `outcome` is `out_of_budget`, that's normal — call `/api/tick` (or wait for the scheduled tick) and it resumes from where it stopped.

## Step 6 — Verify

```bash
curl -s https://your-project.vercel.app/api/status | jq
```

`/api/status` is unauthenticated but exposes only counts and statuses. It returns **503** if the newest digest failed or Postgres is unreachable, so you can point an uptime monitor straight at it. Check:

- `database: "connected"`
- `llmConfigured: true` (if false, you'll get heuristic output)
- `latest.status: "published"`
- `failingSources: []`

Then open the site. `/` shows the latest issue, `/archive` the history, `/feed.xml` the RSS.

## Step 7 — Fast recovery (optional but recommended on Hobby)

The daily cron alone means a failed run waits 24 hours. `.github/workflows/tick.yml` calls `/api/tick` every 15 minutes, which is idempotent and a cheap no-op once the day is published.

Add two repository secrets under **Settings → Secrets and variables → Actions**:

- `SITE_URL` — `https://your-project.vercel.app` (no trailing slash)
- `CRON_SECRET` — the same value you set in Vercel

The workflow also has a **manual trigger with a date input**, which is how you backfill:

```
Actions → Digest tick → Run workflow → date: 2026-08-15
```

On a Vercel **Pro** plan you can delete the workflow and schedule the cron every few minutes instead — Pro allows per-minute crons, and both routes share the same logic.

---

## Operating it

**Costs at this volume:** free, with room to spare.

| | Free allowance | This service uses |
|---|---|---|
| Vercel functions | Generous on Hobby | ~1 cron run + ~96 tick no-ops/day |
| Supabase database | 500 MB on Free | Grows slowly; `raw_items` dominates |
| LLM | — | One call/day (~20k input tokens) |

Supabase Free does not sleep after five idle minutes the way some serverless Postgres plans do. Unused **projects** can still pause after a week of inactivity; a daily cron (and the optional Actions tick) keeps this one awake. Page caching (5 min on `/`, 1 hour on dated issues) keeps most visits off the database.

**Storage growth.** `raw_items` is the only table that grows meaningfully. If you approach 0.5 GB, prune old rows — exceeding the cap makes writes fail until you free space:

```sql
DELETE FROM raw_items WHERE fetched_at < now() - interval '90 days';
```

**Tuning synthesis.** `SYNTH_MAX_CORPUS` defaults to 60 items for a measured reason: at 120 items with an 8k output budget, a live Sonnet call did not return within 10 minutes, which on Vercel means the function is killed and the day publishes nothing. At 60 items it returns in ~40s with tighter themes. Raise it only if you also raise `LLM_TIMEOUT_MS` and have verified the latency yourself.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Cron returns 401 | `CRON_SECRET` missing or mismatched | Set it in Vercel; redeploy so the runtime picks it up |
| Deploy fails on the cron expression | Hobby rejects sub-daily schedules | Keep `0 13 * * *`; use the GitHub Actions tick for frequency |
| `outcome: "out_of_budget"` repeatedly | Sources are slow | Each tick still makes forward progress; check `/api/status` `pending` shrinking |
| `skipped: true, reason: "locked"` | Another run holds the lease | Expected under overlap. Leases expire on their own |
| Migration errors mentioning `SET` or prepared statements | Migrating through port 6543 | Use the direct URI, or Session pooler on 5432 |
| `ENETUNREACH` during migrate | Direct host is IPv6-only | Session pooler (`pooler.supabase.com:5432`) as `DIRECT_DATABASE_URL` |
| `reddit` always `skipped` | Reddit 403s datacenter IPs, including Vercel's | Set `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` |
| `github-trending` skipped | Unauthenticated search 403 from Vercel | Set `GITHUB_TOKEN` |
| `exa-x` / `exa-people` `skipped` | No `EXA_API_KEY` | Optional; Techmeme, Bluesky, and newsletters still carry the X tier |
| Digest published but themes look like `word / word / word` | No LLM key, or the call failed | Check `llmConfigured` in `/api/status`; the intro states the failure reason |
| Site shows "database isn't reachable" | Schema not applied | Run `npm run db:migrate` |

## Local development

No Postgres needed. The harness uses PGlite (real Postgres compiled to WASM):

```bash
npm run digest:local   # full pipeline against live sources, prints per-source health
npm test               # lock, resumability, and synthesis tests — no network, no keys
```
