/**
 * The digest covers a rolling 24h window that closes at the cron time.
 * Everything downstream reads the window from the digest row, so a backfill
 * for an older date produces exactly the same shape as a live run.
 */
export type Window = { start: Date; end: Date; date: string };

export function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * A real calendar date in `YYYY-MM-DD` form — not merely digit-shaped.
 *
 * The two date-keyed API routes used to check shape alone (`/^\d{4}-\d{2}-\d{2}$/`),
 * which accepts `2026-02-30` and `2026-13-45` as well-formed. Both then handed
 * the string straight to a Postgres `date` column comparison, which rejects an
 * impossible date with `invalid input syntax for type date` — uncaught, so it
 * surfaced as a bare 500 with no body instead of the 400 a bad date already
 * gets everywhere else. `Date.UTC` normalizes out-of-range fields (day 30 in a
 * 28-day February becomes March 2) rather than rejecting them, so validity is
 * checked by round-tripping and requiring the ISO string come back unchanged.
 */
export function isValidDateKey(key: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  const d = new Date(`${key}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && toDateKey(d) === key;
}

export function windowFor(end: Date = new Date(), hours = 24): Window {
  const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
  return { start, end, date: toDateKey(end) };
}

export function windowForDate(dateKey: string, hours = 24): Window {
  // Window closes at 13:00 UTC on the given date, matching the cron schedule.
  const end = new Date(`${dateKey}T13:00:00.000Z`);
  const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
  return { start, end, date: dateKey };
}

export function hoursAgo(d: Date | null | undefined, now = new Date()): number {
  if (!d) return Number.POSITIVE_INFINITY;
  return (now.getTime() - d.getTime()) / 3_600_000;
}

/** Points per hour since publication — surfaces fast risers over old giants. */
export function velocity(
  score: number | null | undefined,
  publishedAt: Date | null | undefined,
  now = new Date(),
): number | null {
  if (score == null || !publishedAt) return null;
  const age = Math.max(hoursAgo(publishedAt, now), 0.5);
  return Number((score / age).toFixed(3));
}
