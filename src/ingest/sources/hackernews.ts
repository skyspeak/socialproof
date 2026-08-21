import { isPeopleMoveHeadline } from "@/lib/people";
import { fetchJson, type IngestItem, type SourceDef } from "../adapter";

type AlgoliaHit = {
  objectID: string;
  title?: string | null;
  story_title?: string | null;
  url?: string | null;
  story_url?: string | null;
  author?: string;
  points?: number | null;
  num_comments?: number | null;
  created_at_i: number;
  story_text?: string | null;
  comment_text?: string | null;
  _tags?: string[];
};

type AlgoliaResponse = { hits: AlgoliaHit[] };

const API = "https://hn.algolia.com/api/v1";

/**
 * Front page / high-signal stories in the window.
 *
 * We ask Algolia for stories above a low points floor rather than the literal
 * front page, because the front page is a snapshot and the window is 24h — a
 * story that peaked at 3am is exactly the kind of thing a daily digest should
 * still catch.
 */
export const hackerNews: SourceDef = {
  slug: "hackernews",
  name: "Hacker News",
  kind: "hackernews",
  tier: "core",
  url: "https://news.ycombinator.com",
  async fetch(window) {
    const since = Math.floor(window.start.getTime() / 1000);
    const until = Math.floor(window.end.getTime() / 1000);
    const params = new URLSearchParams({
      tags: "story",
      numericFilters: `created_at_i>${since},created_at_i<${until},points>30`,
      hitsPerPage: "80",
    });

    const data = await fetchJson<AlgoliaResponse>(`${API}/search?${params}`);

    return data.hits
      .filter((h) => h.title)
      .map<IngestItem>((h) => ({
        externalId: h.objectID,
        title: h.title!,
        url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
        body: h.story_text ?? null,
        author: h.author ?? null,
        score: h.points ?? null,
        commentCount: h.num_comments ?? null,
        discussionUrl: `https://news.ycombinator.com/item?id=${h.objectID}`,
        publishedAt: new Date(h.created_at_i * 1000),
        raw: { tags: h._tags },
      }));
  },
};

/**
 * The most-engaged comments of the window. Comment text is where HN actually
 * says what it thinks, and it's the best raw material for theme synthesis —
 * a story title tells you what happened, the top comment tells you why people care.
 */
export const hackerNewsComments: SourceDef = {
  slug: "hackernews-comments",
  name: "Hacker News (top comments)",
  kind: "hackernews",
  tier: "core",
  url: "https://news.ycombinator.com",
  async fetch(window) {
    const since = Math.floor(window.start.getTime() / 1000);
    const until = Math.floor(window.end.getTime() / 1000);
    const params = new URLSearchParams({
      tags: "comment",
      numericFilters: `created_at_i>${since},created_at_i<${until}`,
      hitsPerPage: "60",
    });

    const data = await fetchJson<AlgoliaResponse>(`${API}/search?${params}`);

    return data.hits
      .filter((h) => (h.comment_text?.length ?? 0) > 240)
      .slice(0, 40)
      .map<IngestItem>((h) => ({
        externalId: `comment-${h.objectID}`,
        title: h.story_title ?? "HN discussion",
        body: h.comment_text ?? null,
        url: h.story_url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
        author: h.author ?? null,
        score: h.points ?? null,
        discussionUrl: `https://news.ycombinator.com/item?id=${h.objectID}`,
        publishedAt: new Date(h.created_at_i * 1000),
        raw: { kind: "comment" },
      }));
  },
};

/**
 * People-beat pass over HN. The resignation/joining post is a reliable genre
 * there, and title-matching it is far cheaper than sending everything to an LLM.
 *
 * Algolia relevance alone is far too loose here — a query for "founder" pulls
 * in most of the day's startup news — so results are post-filtered for the
 * shape of an actual personnel announcement.
 */
export const hackerNewsPeople: SourceDef = {
  slug: "hackernews-people",
  name: "Hacker News (people moves)",
  kind: "hackernews",
  tier: "people",
  url: "https://news.ycombinator.com",
  async fetch(window) {
    const since = Math.floor(window.start.getTime() / 1000);
    const until = Math.floor(window.end.getTime() / 1000);
    const queries = [
      "leaving",
      "resigns",
      "steps down",
      "joins",
      "departs",
      "new CEO",
      "appointed",
      "out of stealth",
    ];

    const seen = new Map<string, IngestItem>();
    for (const q of queries) {
      const params = new URLSearchParams({
        query: q,
        tags: "story",
        numericFilters: `created_at_i>${since},created_at_i<${until},points>10`,
        hitsPerPage: "20",
      });
      try {
        const data = await fetchJson<AlgoliaResponse>(`${API}/search?${params}`);
        for (const h of data.hits) {
          if (!h.title || seen.has(h.objectID)) continue;
          // The decisive filter: shape, not keyword.
          if (!isPeopleMoveHeadline(h.title)) continue;
          seen.set(h.objectID, {
            externalId: `people-${h.objectID}`,
            title: h.title,
            url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
            body: h.story_text ?? null,
            author: h.author ?? null,
            score: h.points ?? null,
            commentCount: h.num_comments ?? null,
            discussionUrl: `https://news.ycombinator.com/item?id=${h.objectID}`,
            publishedAt: new Date(h.created_at_i * 1000),
            raw: { matchedQuery: q },
          });
        }
      } catch {
        // One bad query shouldn't sink the whole people pass.
        continue;
      }
    }
    return [...seen.values()];
  },
};
