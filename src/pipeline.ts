import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { digests, runSources, runs } from "@/db/schema";
import {
  countWindowItems,
  ensureDigest,
  ingestChunk,
  loadWindowItems,
  type SourceOutcome,
} from "@/ingest/run";
import { persistSynthesis, synthesize } from "@/synth";
import { ALL_SOURCES } from "@/ingest/registry";
import { renewLock, type Lease } from "@/lib/lock";
import type { Window } from "@/lib/window";

/**
 * How much of the function's wall clock we're willing to spend before stopping
 * cleanly. Vercel's Fluid compute ceiling is 300s on every plan, so we leave a
 * ~50s margin for synthesis teardown and the response.
 */
export const DEFAULT_BUDGET_MS = 240_000;

/** Sources ingested per inner batch, between budget checks and lease renewals. */
const BATCH_SIZE = 4;

export type AdvanceResult = {
  digestId: string;
  date: string;
  /** ingested | synthesized | already_published | out_of_budget */
  outcome: "ingested" | "synthesized" | "already_published" | "out_of_budget";
  sourcesDone: number;
  sourcesTotal: number;
  pending: string[];
  batchOutcomes: SourceOutcome[];
  itemCount?: number;
  themeCount?: number;
  peopleCount?: number;
  provider?: string;
  elapsedMs: number;
};

/**
 * Which sources have already been attempted for this digest.
 *
 * Progress is derived from the run log rather than tracked in a separate
 * cursor column: whatever `run_sources` recorded is, by definition, what
 * happened. That keeps resume correct even if a run dies between writes.
 */
async function attemptedSlugs(digestId: string): Promise<Set<string>> {
  const db = await getDb();
  const runRows = await db
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.digestId, digestId));
  if (runRows.length === 0) return new Set();

  const rows = await db
    .select({ slug: runSources.sourceSlug })
    .from(runSources)
    .where(
      inArray(
        runSources.runId,
        runRows.map((r) => r.id),
      ),
    );
  return new Set(rows.map((r) => r.slug));
}

/**
 * Advance today's digest as far as the time budget allows, then return.
 *
 * This replaced an earlier design where each chunk re-invoked the next over
 * HTTP. That pattern is unsound on Vercel: once a handler returns its response
 * the execution context can be frozen, so an un-awaited `fetch` may never
 * leave the box — the chain silently dies mid-run. Doing the work inline and
 * resuming on the next tick has no such failure mode, and since `waitUntil`
 * counts against the same `maxDuration` anyway, chaining bought nothing.
 */
export async function advance(
  window: Window,
  opts: { budgetMs?: number; lease?: Lease } = {},
): Promise<AdvanceResult> {
  const startedAt = Date.now();
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const db = await getDb();

  const digestId = await ensureDigest(window);
  const [digest] = await db
    .select({ status: digests.status })
    .from(digests)
    .where(eq(digests.id, digestId))
    .limit(1);

  const done = await attemptedSlugs(digestId);
  const pending = ALL_SOURCES.filter((s) => !done.has(s.slug)).map((s) => s.slug);

  // Nothing left to do for a day that already shipped.
  if (digest?.status === "published" && pending.length === 0) {
    return {
      digestId,
      date: window.date,
      outcome: "already_published",
      sourcesDone: done.size,
      sourcesTotal: ALL_SOURCES.length,
      pending: [],
      batchOutcomes: [],
      elapsedMs: Date.now() - startedAt,
    };
  }

  // ---- Ingest phase --------------------------------------------------------
  const batchOutcomes: SourceOutcome[] = [];
  const queue = [...pending];
  let didWork = false;

  while (queue.length > 0) {
    // Budget is only enforced AFTER at least one batch has run. Checking it
    // first meant a tick whose setup queries alone exceeded the budget would
    // return having done nothing — and since nothing changed, every subsequent
    // tick would do the same. That's a livelock, not a slow pipeline. This
    // guarantees each invocation makes forward progress.
    if (didWork && Date.now() - startedAt > budgetMs) {
      return {
        digestId,
        date: window.date,
        outcome: "out_of_budget",
        sourcesDone: ALL_SOURCES.length - queue.length,
        sourcesTotal: ALL_SOURCES.length,
        pending: queue,
        batchOutcomes,
        elapsedMs: Date.now() - startedAt,
      };
    }

    const batch = queue.splice(0, BATCH_SIZE);
    const { outcomes } = await ingestChunk({ digestId, window, slugs: batch });
    batchOutcomes.push(...outcomes);
    didWork = true;

    if (opts.lease) await renewLock(opts.lease, budgetMs);
  }

  // ---- Synthesis phase ----------------------------------------------------
  // Reserve budget for the model call; if this tick already spent its time
  // ingesting, stop and let the next one synthesize from what's stored.
  //
  // The `didWork` guard matters for the same reason as above: when ingestion was
  // already complete on entry, synthesis is the ONLY remaining work, so
  // deferring it on a tight budget would defer it forever.
  const remaining = budgetMs - (Date.now() - startedAt);
  if (didWork && remaining < 45_000) {
    return {
      digestId,
      date: window.date,
      outcome: "out_of_budget",
      sourcesDone: ALL_SOURCES.length,
      sourcesTotal: ALL_SOURCES.length,
      pending: [],
      batchOutcomes,
      elapsedMs: Date.now() - startedAt,
    };
  }

  await db
    .update(digests)
    .set({ status: "synthesizing" })
    .where(eq(digests.id, digestId));

  const [run] = await db
    .insert(runs)
    .values({ digestId, phase: "synthesize", status: "running" })
    .returning({ id: runs.id });
  const synthStart = Date.now();

  try {
    const items = await loadWindowItems(window);
    const output = await synthesize(items, window);
    const itemCount = await countWindowItems(window);
    await persistSynthesis(digestId, output, itemCount);

    await db
      .update(runs)
      .set({
        status: "ok",
        finishedAt: new Date(),
        durationMs: Date.now() - synthStart,
        itemsIngested: itemCount,
      })
      .where(eq(runs.id, run.id));

    return {
      digestId,
      date: window.date,
      outcome: "synthesized",
      sourcesDone: ALL_SOURCES.length,
      sourcesTotal: ALL_SOURCES.length,
      pending: [],
      batchOutcomes,
      itemCount,
      themeCount: output.themes.length,
      peopleCount: output.peopleMoves.length,
      provider: output.provider,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(runs)
      .set({
        status: "failed",
        finishedAt: new Date(),
        durationMs: Date.now() - synthStart,
        error: message,
      })
      .where(eq(runs.id, run.id));
    await db
      .update(digests)
      .set({ status: "failed" })
      .where(eq(digests.id, digestId));
    throw err;
  }
}

/**
 * Drive a digest to completion across as many budgeted passes as it takes.
 * Used by the local harness and by backfills, where there's no function ceiling.
 */
export async function runToCompletion(
  window: Window,
  onPass?: (r: AdvanceResult) => void,
): Promise<AdvanceResult> {
  for (let pass = 0; pass < 12; pass++) {
    const result = await advance(window, { budgetMs: 10 * 60_000 });
    onPass?.(result);
    if (result.outcome === "synthesized" || result.outcome === "already_published") {
      return result;
    }
  }
  throw new Error("Pipeline did not converge after 12 passes");
}
