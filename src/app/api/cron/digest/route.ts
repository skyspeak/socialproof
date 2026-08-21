import { NextResponse } from "next/server";
import { advance, DEFAULT_BUDGET_MS } from "@/pipeline";
import { authorized } from "@/lib/site";
import { withLock } from "@/lib/lock";
import { windowFor } from "@/lib/window";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * 300s is the Fluid compute ceiling on every plan (Hobby included), so we take
 * all of it and let the pipeline's own budget stop short of the wall.
 * Declared here rather than in vercel.json: for App Router the route export
 * takes precedence, and a vercel.json glob that stops matching after a file
 * move fails silently.
 */
export const maxDuration = 300;

/**
 * Daily cron entry point.
 *
 * Vercel always invokes crons with GET against the production deployment, and
 * sends `Authorization: Bearer $CRON_SECRET` when that variable is set.
 * It does not deduplicate overlapping invocations, hence the lease.
 */
export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const window = windowFor(new Date());

  const result = await withLock("digest-pipeline", DEFAULT_BUDGET_MS + 30_000, (lease) =>
    advance(window, { lease }),
  ).catch((err) => {
    return { error: err instanceof Error ? err.message : String(err) } as const;
  });

  if (result === null) {
    // Another invocation is mid-run. Not an error — the point of the lease.
    return NextResponse.json(
      { skipped: true, reason: "another run holds the lease" },
      { status: 200 },
    );
  }

  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    date: result.date,
    outcome: result.outcome,
    sources: `${result.sourcesDone}/${result.sourcesTotal}`,
    pending: result.pending,
    themes: result.themeCount,
    people: result.peopleCount,
    items: result.itemCount,
    provider: result.provider,
    elapsedMs: result.elapsedMs,
    failedSources: result.batchOutcomes
      .filter((o) => o.status === "failed")
      .map((o) => ({ slug: o.slug, error: o.error })),
  });
}
