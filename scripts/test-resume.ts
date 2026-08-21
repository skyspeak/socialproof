/**
 * Verifies the resumability contract that replaced the old HTTP worker chain.
 *
 * The claim being tested: if a function is killed partway through (budget
 * exhausted, timeout, deploy), the next tick picks up exactly where it stopped
 * and does NOT re-ingest sources that already ran. That property is the whole
 * reason the pipeline is safe to drive from a once-a-day cron plus an
 * idempotent tick, so it deserves a test rather than a comment.
 *
 *   npx tsx scripts/test-resume.ts
 */
import assert from "node:assert";

process.env.DATABASE_URL = "pglite://./.pglite-resume-test";

async function main() {
  const { PGlite } = await import("@electric-sql/pglite");
  const { readFileSync, readdirSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");

  const dir = process.env.DATABASE_URL!.slice("pglite://".length);
  rmSync(dir, { recursive: true, force: true });

  const client = new PGlite(dir);
  await client.waitReady;
  for (const f of readdirSync("drizzle").filter((f) => f.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join("drizzle", f), "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean)) {
      await client.exec(stmt);
    }
  }
  await client.close();

  const { advance } = await import("../src/pipeline");
  const { ALL_SOURCES } = await import("../src/ingest/registry");
  const { windowFor } = await import("../src/lib/window");
  const { getDb } = await import("../src/db");
  const { runSources, runs } = await import("../src/db/schema");
  const { eq, inArray } = await import("drizzle-orm");

  const window = windowFor(new Date());
  const checks: Array<[string, boolean]> = [];

  // Budget of 1ms: the loop checks its budget before each batch, so this stops
  // after a single batch every time — a deterministic stand-in for being killed.
  let passes = 0;
  let lastOutcome = "";
  const seenPending: number[] = [];

  for (let i = 0; i < 20; i++) {
    const r = await advance(window, { budgetMs: 1 });
    passes++;
    lastOutcome = r.outcome;
    seenPending.push(r.pending.length);
    if (r.outcome === "synthesized") break;
    if (r.outcome !== "out_of_budget") break;
  }

  checks.push([
    `took multiple passes to finish (took ${passes})`,
    passes > 2,
  ]);
  checks.push(["eventually reached synthesis", lastOutcome === "synthesized"]);
  checks.push([
    "pending count decreased monotonically across passes",
    seenPending.every((n, i) => i === 0 || n <= seenPending[i - 1]),
  ]);

  // The core assertion: no source was attempted twice.
  const db = await getDb();
  const runRows = await db.select({ id: runs.id }).from(runs);
  const attempts = await db
    .select({ slug: runSources.sourceSlug })
    .from(runSources)
    .where(
      inArray(
        runSources.runId,
        runRows.map((r) => r.id),
      ),
    );

  const counts = new Map<string, number>();
  for (const a of attempts) counts.set(a.slug, (counts.get(a.slug) ?? 0) + 1);
  const duplicated = [...counts.entries()].filter(([, n]) => n > 1);

  checks.push([
    `every source ingested exactly once across resumes (${counts.size}/${ALL_SOURCES.length} sources, ${duplicated.length} duplicated)`,
    duplicated.length === 0 && counts.size === ALL_SOURCES.length,
  ]);

  // A tick after publication must be a cheap no-op, not a re-run.
  const afterPublish = await advance(window, { budgetMs: 60_000 });
  checks.push([
    "a tick after publication is a no-op",
    afterPublish.outcome === "already_published",
  ]);

  const runRowsAfter = await db.select({ id: runs.id }).from(runs);
  const synthRuns = await db
    .select({ phase: runs.phase })
    .from(runs)
    .where(eq(runs.phase, "synthesize"));
  checks.push([
    `synthesis ran once, not once per pass (${synthRuns.length})`,
    synthRuns.length === 1,
  ]);
  void runRowsAfter;

  let failed = 0;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? "✓" : "✗"} ${label}`);
    if (!ok) failed++;
  }
  console.log(
    failed === 0 ? "\n✓ resumability verified\n" : `\n✗ ${failed} check(s) failed\n`,
  );
  assert.equal(failed, 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
