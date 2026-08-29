import { titleSimilarity, normalizeTitle } from "@/lib/canonical";

export const CONTINUITY_THRESHOLD = 0.5;

export type ThemeName = { date: string; name: string };

export type ContinuityHit = {
  previousDate: string;
  previousName: string;
  score: number;
};

/**
 * Pair today's theme names to yesterday's, greedily, one-to-one.
 *
 * A model claiming `isNew` is a vibe. Overlap with yesterday's masthead is
 * evidence. Greedy highest-score-first so two of today's themes cannot claim
 * the same yesterday thread.
 */
export function pairContinuity(
  today: readonly string[],
  yesterday: readonly string[],
  threshold = CONTINUITY_THRESHOLD,
): Array<{ todayIndex: number; yesterdayIndex: number; score: number }> {
  const pairs: Array<{ todayIndex: number; yesterdayIndex: number; score: number }> =
    [];
  for (let i = 0; i < today.length; i++) {
    for (let j = 0; j < yesterday.length; j++) {
      const score = titleSimilarity(today[i], yesterday[j]);
      if (score >= threshold) pairs.push({ todayIndex: i, yesterdayIndex: j, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score);

  const usedToday = new Set<number>();
  const usedYesterday = new Set<number>();
  const taken: typeof pairs = [];
  for (const p of pairs) {
    if (usedToday.has(p.todayIndex) || usedYesterday.has(p.yesterdayIndex)) continue;
    usedToday.add(p.todayIndex);
    usedYesterday.add(p.yesterdayIndex);
    taken.push(p);
  }
  return taken;
}

export function continuityFor(
  name: string,
  previous: readonly ThemeName[],
  alreadyClaimed: Set<string>,
  threshold = CONTINUITY_THRESHOLD,
): ContinuityHit | null {
  let best: ContinuityHit | null = null;
  for (const prev of previous) {
    const key = `${prev.date}|${prev.name}`;
    if (alreadyClaimed.has(key)) continue;
    const score = titleSimilarity(name, prev.name);
    if (score >= threshold && (!best || score > best.score)) {
      best = { previousDate: prev.date, previousName: prev.name, score };
    }
  }
  return best;
}

/** Apply yesterday's masthead onto today's themes. Mutates isNew. */
export function applyContinuity<T extends { name: string; isNew: boolean }>(
  themes: T[],
  previous: readonly ThemeName[],
): T[] {
  const yesterday = previous.map((p) => p.name);
  const pairs = pairContinuity(
    themes.map((t) => t.name),
    yesterday,
  );
  const byToday = new Map(pairs.map((p) => [p.todayIndex, p]));
  return themes.map((t, i) => {
    const hit = byToday.get(i);
    if (!hit) return t;
    return { ...t, isNew: false };
  });
}

/**
 * A move is only suppressible when we have a person and an organization.
 * Name-only matches are too loose ("Sam" appears every week).
 */
export function moveFingerprint(p: {
  person: string;
  fromOrg?: string | null;
  toOrg?: string | null;
}): string | null {
  const person = normalizeTitle(p.person);
  const org = normalizeTitle(p.toOrg || p.fromOrg || "");
  if (!person || person.length < 3 || !org) return null;
  return `${person}|${org}`;
}

export function dropRepeatMoves<T extends {
  person: string;
  fromOrg?: string | null;
  toOrg?: string | null;
}>(moves: T[], recent: ReadonlySet<string>): T[] {
  const seen = new Set(recent);
  const out: T[] = [];
  for (const m of moves) {
    const key = moveFingerprint(m);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(m);
  }
  return out.map((m, rank) => ({ ...m, rank }) as T);
}

export function utcWeekday(dateKey: string): number {
  return new Date(`${dateKey}T12:00:00Z`).getUTCDay();
}

export function isWeekendEdition(dateKey: string): boolean {
  const d = utcWeekday(dateKey);
  return d === 0 || d === 6;
}
