import { and, eq, gte, lte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { rawItems, runs, runSources, sources, digests } from "@/db/schema";
import { canonicalizeUrl, contentHash } from "@/lib/canonical";
import { velocity, type Window } from "@/lib/window";
import { SkipSource, type SourceDef } from "./adapter";
import { ALL_SOURCES } from "./registry";

export type SourceOutcome = {
  slug: string;
  status: "ok" | "empty" | "failed" | "skipped";
  itemsFound: number;
  itemsNew: number;
  durationMs: number;
  error?: string;
};

/** Ensure every registered source has a row, and return slug → id. */
async function syncSourceRows(): Promise<Map<string, string>> {
  const db = await getDb();
  const map = new Map<string, string>();

  for (const def of ALL_SOURCES) {
    const [row] = await db
      .insert(sources)
      .values({
        slug: def.slug,
        name: def.name,
        kind: def.kind,
        tier: def.tier,
        url: def.url ?? null,
        config: def.config ?? null,
      })
      .onConflictDoUpdate({
        target: sources.slug,
        set: { name: def.name, kind: def.kind, tier: def.tier },
      })
      .returning({ id: sources.id, slug: sources.slug });
    map.set(row.slug, row.id);
  }
  return map;
}

/**
 * Ingest one source. Never throws — the outcome is the return value, so one
 * dead scraper degrades the digest instead of failing the run.
 */
async function ingestSource(
  def: SourceDef,
  sourceId: string,
  window: Window,
): Promise<SourceOutcome> {
  const startedAt = Date.now();
  const db = await getDb();

  try {
    const items = await def.fetch(window);
    let itemsNew = 0;

    for (const item of items) {
      const url = item.url ?? null;
      const canonical = canonicalizeUrl(url);
      const hash = contentHash(item.title, item.body);

      const inserted = await db
        .insert(rawItems)
        .values({
          sourceId,
          externalId: item.externalId,
          url,
          canonicalUrl: canonical,
          contentHash: hash,
          title: item.title,
          body: item.body ?? null,
          author: item.author ?? null,
          score: item.score ?? null,
          commentCount: item.commentCount ?? null,
          velocity: velocity(item.score, item.publishedAt, window.end),
          discussionUrl: item.discussionUrl ?? null,
          publishedAt: item.publishedAt ?? null,
          raw: item.raw ?? null,
        })
        .onConflictDoUpdate({
          target: [rawItems.sourceId, rawItems.externalId],
          set: {
            score: item.score ?? null,
            commentCount: item.commentCount ?? null,
            velocity: velocity(item.score, item.publishedAt, window.end),
            fetchedAt: new Date(),
          },
        })
        .returning({ id: rawItems.id, fetchedAt: rawItems.fetchedAt });

      if (inserted.length) itemsNew++;
    }

    return {
      slug: def.slug,
      status: items.length ? "ok" : "empty",
      itemsFound: items.length,
      itemsNew,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const skipped = err instanceof SkipSource;
    return {
      slug: def.slug,
      status: skipped ? "skipped" : "failed",
      itemsFound: 0,
      itemsNew: 0,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Ingest a named set of sources.
 *
 * Takes explicit slugs rather than an offset/limit window: an earlier version
 * derived position arithmetically, which silently assumed the already-completed
 * sources formed a prefix of the registry. Once resume entered the picture that
 * assumption could skip sources entirely. Naming them removes the class of bug.
 */
export async function ingestChunk(opts: {
  digestId: string;
  window: Window;
  slugs: string[];
  concurrency?: number;
}): Promise<{ outcomes: SourceOutcome[]; skipped: string[] }> {
  const db = await getDb();
  const sourceIds = await syncSourceRows();

  const enabled = await db.select().from(sources).where(eq(sources.enabled, true));
  const enabledSlugs = new Set(enabled.map((s) => s.slug));

  const requested = new Set(opts.slugs);
  const slice = ALL_SOURCES.filter(
    (s) => requested.has(s.slug) && enabledSlugs.has(s.slug),
  );
  // Sources disabled in the DB are reported back so the caller doesn't wait
  // on them forever.
  const skipped = opts.slugs.filter((s) => !slice.some((d) => d.slug === s));

  const [run] = await db
    .insert(runs)
    .values({ digestId: opts.digestId, phase: "ingest", status: "running" })
    .returning({ id: runs.id });

  // Bounded concurrency: fast enough to fit the budget, polite enough not to
  // get rate-limited by four different hosts at once.
  const concurrency = opts.concurrency ?? 4;
  const outcomes: SourceOutcome[] = [];
  for (let i = 0; i < slice.length; i += concurrency) {
    const batch = slice.slice(i, i + concurrency);
    const settled = await Promise.all(
      batch.map((def) => ingestSource(def, sourceIds.get(def.slug)!, opts.window)),
    );
    outcomes.push(...settled);
  }

  for (const o of outcomes) {
    await db.insert(runSources).values({
      runId: run.id,
      sourceSlug: o.slug,
      status: o.status,
      itemsFound: o.itemsFound,
      itemsNew: o.itemsNew,
      durationMs: o.durationMs,
      error: o.error ?? null,
    });
  }

  const failed = outcomes.filter((o) => o.status === "failed").length;
  const totalItems = outcomes.reduce((n, o) => n + o.itemsFound, 0);

  await db
    .update(runs)
    .set({
      status: failed === 0 ? "ok" : failed === outcomes.length ? "failed" : "partial",
      finishedAt: new Date(),
      durationMs: outcomes.reduce((n, o) => n + o.durationMs, 0),
      itemsIngested: totalItems,
    })
    .where(eq(runs.id, run.id));

  return { outcomes, skipped };
}

/**
 * Cross-source dedup for the window: collapse items sharing a canonical URL or
 * content hash, keeping the highest-scoring representative and recording how
 * many sources carried it (corroboration is itself a signal of importance).
 */
export type DedupedItem = {
  id: string;
  title: string;
  url: string | null;
  body: string | null;
  author: string | null;
  score: number | null;
  commentCount: number | null;
  velocity: number | null;
  discussionUrl: string | null;
  publishedAt: Date | null;
  sourceSlug: string;
  tier: string;
  duplicateCount: number;
  alsoSeenIn: string[];
};

export async function loadWindowItems(window: Window): Promise<DedupedItem[]> {
  const db = await getDb();

  const rows = await db
    .select({
      id: rawItems.id,
      title: rawItems.title,
      url: rawItems.url,
      canonicalUrl: rawItems.canonicalUrl,
      contentHash: rawItems.contentHash,
      body: rawItems.body,
      author: rawItems.author,
      score: rawItems.score,
      commentCount: rawItems.commentCount,
      velocity: rawItems.velocity,
      discussionUrl: rawItems.discussionUrl,
      publishedAt: rawItems.publishedAt,
      sourceSlug: sources.slug,
      tier: sources.tier,
    })
    .from(rawItems)
    .innerJoin(sources, eq(rawItems.sourceId, sources.id))
    .where(
      and(
        gte(rawItems.fetchedAt, new Date(window.start.getTime() - 3_600_000)),
        lte(rawItems.fetchedAt, new Date(window.end.getTime() + 3_600_000)),
      ),
    );

  const byKey = new Map<string, DedupedItem>();

  for (const r of rows) {
    const key = r.canonicalUrl ?? r.contentHash ?? r.id;
    const existing = byKey.get(key);

    if (!existing) {
      byKey.set(key, {
        id: r.id,
        title: r.title,
        url: r.url,
        body: r.body,
        author: r.author,
        score: r.score,
        commentCount: r.commentCount,
        velocity: r.velocity,
        discussionUrl: r.discussionUrl,
        publishedAt: r.publishedAt,
        sourceSlug: r.sourceSlug,
        tier: r.tier,
        duplicateCount: 1,
        alsoSeenIn: [],
      });
      continue;
    }

    existing.duplicateCount++;
    if (!existing.alsoSeenIn.includes(r.sourceSlug)) {
      existing.alsoSeenIn.push(r.sourceSlug);
    }
    // Keep the richest representative of the cluster.
    if ((r.score ?? 0) > (existing.score ?? 0)) {
      existing.score = r.score;
      existing.discussionUrl = r.discussionUrl ?? existing.discussionUrl;
      existing.commentCount = r.commentCount ?? existing.commentCount;
    }
    if (!existing.body && r.body) existing.body = r.body;
  }

  return [...byKey.values()];
}

/** Create or fetch the digest row for a window. */
export async function ensureDigest(window: Window): Promise<string> {
  const db = await getDb();
  const [row] = await db
    .insert(digests)
    .values({
      digestDate: window.date,
      status: "ingesting",
      windowStart: window.start,
      windowEnd: window.end,
    })
    .onConflictDoUpdate({
      target: digests.digestDate,
      set: { windowStart: window.start, windowEnd: window.end },
    })
    .returning({ id: digests.id });
  return row.id;
}

export async function countWindowItems(window: Window): Promise<number> {
  const db = await getDb();
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(rawItems)
    .where(
      and(
        gte(rawItems.fetchedAt, new Date(window.start.getTime() - 3_600_000)),
        lte(rawItems.fetchedAt, new Date(window.end.getTime() + 3_600_000)),
      ),
    );
  return row?.n ?? 0;
}
