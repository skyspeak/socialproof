import type { SourceDef } from "./adapter";
import {
  hackerNews,
  hackerNewsComments,
  hackerNewsPeople,
} from "./sources/hackernews";
import { lobsters } from "./sources/lobsters";
import { reddit } from "./sources/reddit";
import { githubTrending } from "./sources/github";
import { arxiv } from "./sources/arxiv";
import { techmeme, techmemePeople, newsletters } from "./sources/rss";
import { exaX, exaPeopleMoves, xMirrors } from "./sources/x-tier";

/**
 * Every source the pipeline knows about. Rows are mirrored into the `sources`
 * table on first run so production can disable one without a deploy.
 */
export const ALL_SOURCES: SourceDef[] = [
  // Tier 1 — open APIs, reliable
  hackerNews,
  hackerNewsComments,
  lobsters,
  githubTrending,
  arxiv,

  // Tier 2 — X signal via the open web
  techmeme,
  reddit,
  exaX,
  xMirrors,
  ...newsletters,

  // Tier 3 — the people beat
  hackerNewsPeople,
  techmemePeople,
  exaPeopleMoves,
];

export function sourceBySlug(slug: string): SourceDef | undefined {
  return ALL_SOURCES.find((s) => s.slug === slug);
}
