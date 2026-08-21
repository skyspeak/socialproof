import { desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import {
  digests,
  peopleMoves,
  rawItems,
  runSources,
  runs,
  sources,
  themeItems,
  themes,
} from "./schema";

export type DigestItemView = {
  id: string;
  title: string;
  url: string | null;
  discussionUrl: string | null;
  sourceName: string;
  score: number | null;
  commentCount: number | null;
};

export type ThemeView = {
  id: string;
  name: string;
  summary: string;
  soWhat: string | null;
  isNew: boolean;
  items: DigestItemView[];
};

export type DigestView = {
  id: string;
  date: string;
  status: string;
  headline: string | null;
  intro: string | null;
  itemCount: number;
  generatedAt: Date | null;
  windowStart: Date;
  windowEnd: Date;
  themes: ThemeView[];
  people: Array<{
    id: string;
    person: string;
    fromOrg: string | null;
    toOrg: string | null;
    role: string | null;
    moveType: string;
    confidence: string;
    note: string | null;
    evidenceUrl: string | null;
  }>;
  sourceHealth: Array<{
    slug: string;
    status: string;
    itemsFound: number;
    error: string | null;
  }>;
};

export async function getDigestDates(limit = 60): Promise<
  Array<{ date: string; headline: string | null; itemCount: number; status: string }>
> {
  const db = await getDb();
  const rows = await db
    .select({
      date: digests.digestDate,
      headline: digests.headline,
      itemCount: digests.itemCount,
      status: digests.status,
    })
    .from(digests)
    .orderBy(desc(digests.digestDate))
    .limit(limit);
  return rows;
}

export async function getLatestDigestDate(): Promise<string | null> {
  const db = await getDb();
  const [row] = await db
    .select({ date: digests.digestDate })
    .from(digests)
    .where(eq(digests.status, "published"))
    .orderBy(desc(digests.digestDate))
    .limit(1);
  return row?.date ?? null;
}

export async function getDigest(dateKey: string): Promise<DigestView | null> {
  const db = await getDb();

  const [digest] = await db
    .select()
    .from(digests)
    .where(eq(digests.digestDate, dateKey))
    .limit(1);
  if (!digest) return null;

  const themeRows = await db
    .select()
    .from(themes)
    .where(eq(themes.digestId, digest.id))
    .orderBy(themes.rank);

  const themeIds = themeRows.map((t) => t.id);

  const links = themeIds.length
    ? await db
        .select({
          themeId: themeItems.themeId,
          rank: themeItems.rank,
          id: rawItems.id,
          title: rawItems.title,
          url: rawItems.url,
          discussionUrl: rawItems.discussionUrl,
          score: rawItems.score,
          commentCount: rawItems.commentCount,
          sourceName: sources.name,
        })
        .from(themeItems)
        .innerJoin(rawItems, eq(themeItems.rawItemId, rawItems.id))
        .innerJoin(sources, eq(rawItems.sourceId, sources.id))
        .where(inArray(themeItems.themeId, themeIds))
        .orderBy(themeItems.rank)
    : [];

  const byTheme = new Map<string, DigestItemView[]>();
  for (const l of links) {
    const list = byTheme.get(l.themeId) ?? [];
    list.push({
      id: l.id,
      title: l.title,
      url: l.url,
      discussionUrl: l.discussionUrl,
      sourceName: l.sourceName,
      score: l.score,
      commentCount: l.commentCount,
    });
    byTheme.set(l.themeId, list);
  }

  const people = await db
    .select()
    .from(peopleMoves)
    .where(eq(peopleMoves.digestId, digest.id))
    .orderBy(peopleMoves.rank);

  const runRows = await db
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.digestId, digest.id));

  const health = runRows.length
    ? await db
        .select({
          slug: runSources.sourceSlug,
          status: runSources.status,
          itemsFound: runSources.itemsFound,
          error: runSources.error,
        })
        .from(runSources)
        .where(
          inArray(
            runSources.runId,
            runRows.map((r) => r.id),
          ),
        )
    : [];

  // Collapse repeated attempts per source, preferring the most successful.
  const healthBySlug = new Map<string, (typeof health)[number]>();
  for (const h of health) {
    const prev = healthBySlug.get(h.slug);
    if (!prev || h.itemsFound > prev.itemsFound) healthBySlug.set(h.slug, h);
  }

  return {
    id: digest.id,
    date: digest.digestDate,
    status: digest.status,
    headline: digest.headline,
    intro: digest.intro,
    itemCount: digest.itemCount,
    generatedAt: digest.generatedAt,
    windowStart: digest.windowStart,
    windowEnd: digest.windowEnd,
    themes: themeRows.map((t) => ({
      id: t.id,
      name: t.name,
      summary: t.summary,
      soWhat: t.soWhat,
      isNew: t.isNew,
      items: byTheme.get(t.id) ?? [],
    })),
    people: people.map((p) => ({
      id: p.id,
      person: p.person,
      fromOrg: p.fromOrg,
      toOrg: p.toOrg,
      role: p.role,
      moveType: p.moveType,
      confidence: p.confidence,
      note: p.note,
      evidenceUrl: p.evidenceUrl,
    })),
    sourceHealth: [...healthBySlug.values()].sort((a, b) =>
      a.slug.localeCompare(b.slug),
    ),
  };
}
