import { NextResponse } from "next/server";
import { advance, DEFAULT_BUDGET_MS } from "@/pipeline";
import { authorized } from "@/lib/site";
import { withLock } from "@/lib/lock";
import { isValidDateKey, windowFor, windowForDate } from "@/lib/window";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Resume endpoint. Idempotent: advances whatever is unfinished and no-ops once
 * the day is published.
 *
 * This exists because Vercel's Hobby plan caps crons at once per day, and a
 * once-a-day schedule is a poor recovery story — a run that dies at 13:01 would
 * wait 24 hours. Pointing any external scheduler (GitHub Actions works and is
 * free) at this route every few minutes turns that into a few minutes, without
 * requiring a Pro plan. On Pro you can skip it and simply schedule the cron
 * more often, since both routes call the same `advance()`.
 *
 * `?date=YYYY-MM-DD` targets a specific day, which is also how backfills run.
 */
async function handle(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const dateParam = searchParams.get("date");
  // Shape alone (`\d{4}-\d{2}-\d{2}`) admits `2026-13-45`. `windowForDate`
  // builds its window with `new Date(...)`, which normalizes an out-of-range
  // month or day into a real one rather than throwing — so a typo'd backfill
  // date would silently ingest under the wrong window before the digest write
  // finally rejects the original string as an invalid date literal.
  if (dateParam && !isValidDateKey(dateParam)) {
    return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  }

  const window = dateParam ? windowForDate(dateParam) : windowFor(new Date());

  try {
    const result = await withLock(
      "digest-pipeline",
      DEFAULT_BUDGET_MS + 30_000,
      (lease) => advance(window, { lease }),
    );

    if (result === null) {
      return NextResponse.json({ skipped: true, reason: "locked" }, { status: 200 });
    }

    return NextResponse.json({
      ok: true,
      date: result.date,
      outcome: result.outcome,
      sources: `${result.sourcesDone}/${result.sourcesTotal}`,
      pending: result.pending,
      elapsedMs: result.elapsedMs,
      themes: result.themeCount,
      people: result.peopleCount,
      provider: result.provider,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
