import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { digests, runSources, runs } from "@/db/schema";
import { ALL_SOURCES } from "@/ingest/registry";
import { inspectLock } from "@/lib/lock";
import { hasLlm } from "@/synth/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Operational status — the endpoint to hit right after deploying, and the one
 * to point an uptime monitor at. Deliberately unauthenticated but non-sensitive:
 * counts and statuses only, no item contents, no configuration values beyond
 * whether a provider key is present.
 *
 * Returns 503 when the newest digest failed or the DB is unreachable, so a
 * monitor can alert without parsing the body.
 */
export async function GET() {
  try {
    const db = await getDb();

    const [latest] = await db
      .select()
      .from(digests)
      .orderBy(desc(digests.digestDate))
      .limit(1);

    if (!latest) {
      return NextResponse.json(
        {
          ok: true,
          database: "connected",
          digests: 0,
          message: "No digest yet. Trigger /api/cron/digest.",
          llmConfigured: hasLlm(),
          sourcesRegistered: ALL_SOURCES.length,
        },
        { status: 200 },
      );
    }

    const runRows = await db
      .select()
      .from(runs)
      .where(eq(runs.digestId, latest.id))
      .orderBy(desc(runs.startedAt));

    const health = runRows.length
      ? await db
          .select({
            slug: runSources.sourceSlug,
            status: runSources.status,
            itemsFound: runSources.itemsFound,
            error: runSources.error,
          })
          .from(runSources)
          .where(eq(runSources.runId, runRows[0].id))
      : [];

    const attempted = new Set(health.map((h) => h.slug));
    const lock = await inspectLock("digest-pipeline");

    const failing = health.filter((h) => h.status === "failed");
    const degraded = latest.status === "failed";

    return NextResponse.json(
      {
        ok: !degraded,
        database: "connected",
        llmConfigured: hasLlm(),
        exaConfigured: Boolean(process.env.EXA_API_KEY),
        latest: {
          date: latest.digestDate,
          status: latest.status,
          items: latest.itemCount,
          generatedAt: latest.generatedAt,
        },
        progress: {
          sourcesRegistered: ALL_SOURCES.length,
          sourcesAttemptedLastRun: attempted.size,
          pending: ALL_SOURCES.filter((s) => !attempted.has(s.slug)).map(
            (s) => s.slug,
          ),
        },
        failingSources: failing.map((f) => ({ slug: f.slug, error: f.error })),
        lock: lock
          ? { held: !lock.expired, expiresAt: lock.expiresAt }
          : { held: false },
        runs: runRows.slice(0, 5).map((r) => ({
          phase: r.phase,
          status: r.status,
          startedAt: r.startedAt,
          durationMs: r.durationMs,
          error: r.error,
        })),
      },
      { status: degraded ? 503 : 200 },
    );
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        database: "unreachable",
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 503 },
    );
  }
}
