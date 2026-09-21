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
import { huggingfacePapers } from "./sources/huggingface";
import { techmeme, techmemePeople, newsletters, tradePress } from "./sources/rss";
import { bookmarksSource } from "./sources/bookmarks";
import { blueskyWatched } from "./sources/bsky";
import { exaX, exaPeopleMoves, xMirrors } from "./sources/x-tier";

/**
 * Every source the pipeline knows about. Rows are mirrored into the `sources`
 * table on first run so production can disable one without a deploy.
 */
export const ALL_SOURCES: SourceDef[] = [
  // Tier 1 — open APIs and trade press
  hackerNews,
  hackerNewsComments,
  lobsters,
  githubTrending,
  arxiv,
  huggingfacePapers,
  ...tradePress,

  // Tier 2 — the industry argument via the open web
  techmeme,
  reddit,
  exaX,
  xMirrors,
  blueskyWatched,
  ...newsletters,

  // Tier 3 — the people beat
  hackerNewsPeople,
  techmemePeople,
  exaPeopleMoves,

  // Reader-selected — bookmarklet / native X bookmarks
  bookmarksSource,
];

const slugs = ALL_SOURCES.map((s) => s.slug);
if (new Set(slugs).size !== slugs.length) {
  const dup = slugs.filter((s, i) => slugs.indexOf(s) !== i);
  throw new Error(`Duplicate source slugs: ${[...new Set(dup)].join(", ")}`);
}

export function sourceBySlug(slug: string): SourceDef | undefined {
  return ALL_SOURCES.find((s) => s.slug === slug);
}
