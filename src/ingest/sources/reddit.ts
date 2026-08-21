import { fetchJson, SkipSource, type IngestItem, type SourceDef } from "../adapter";

type RedditListing = {
  data: {
    children: Array<{
      data: {
        id: string;
        title: string;
        url?: string;
        permalink: string;
        author?: string;
        score?: number;
        num_comments?: number;
        created_utc: number;
        selftext?: string;
        subreddit: string;
        stickied?: boolean;
      };
    }>;
  };
};

const SUBREDDITS = [
  "LocalLLaMA",
  "MachineLearning",
  "ExperiencedDevs",
  "programming",
];

/**
 * Reddit stands in for a chunk of the X conversation — the same arguments,
 * minus the login wall. r/LocalLLaMA in particular front-runs open-model
 * discourse by a day or two.
 *
 * Uses the public .json endpoints (no OAuth). Reddit rate-limits aggressively
 * from datacenter IPs, so failures here are expected and non-fatal.
 */
export const reddit: SourceDef = {
  slug: "reddit",
  name: "Reddit (tech subs)",
  kind: "reddit",
  tier: "x_adjacent",
  url: "https://www.reddit.com",
  async fetch(window) {
    const items: IngestItem[] = [];
    let failures = 0;

    for (const sub of SUBREDDITS) {
      try {
        const data = await fetchJson<RedditListing>(
          `https://www.reddit.com/r/${sub}/top.json?t=day&limit=25`,
        );
        for (const { data: p } of data.data.children) {
          if (p.stickied) continue;
          const at = new Date(p.created_utc * 1000);
          if (at < window.start || at > window.end) continue;
          if ((p.score ?? 0) < 50) continue;

          items.push({
            externalId: `${sub}-${p.id}`,
            title: p.title,
            url: p.url ?? `https://www.reddit.com${p.permalink}`,
            body: p.selftext?.slice(0, 2000) || null,
            author: p.author ?? null,
            score: p.score ?? null,
            commentCount: p.num_comments ?? null,
            discussionUrl: `https://www.reddit.com${p.permalink}`,
            publishedAt: at,
            raw: { subreddit: p.subreddit },
          });
        }
      } catch {
        // Per-subreddit failure is tolerated, but counted — see below.
        failures++;
        continue;
      }
    }

    // Reddit blocks unauthenticated reads from datacenter IPs, which is exactly
    // where this runs. Reporting that as "empty" would be a lie: an empty result
    // means a quiet day, a blocked result means the source is dark. Distinguish
    // them so the run log stays trustworthy.
    if (failures === SUBREDDITS.length) {
      throw new SkipSource(
        "all subreddits unreachable (Reddit commonly returns 403 to datacenter IPs; needs an OAuth app to be reliable)",
      );
    }

    return items;
  },
};
