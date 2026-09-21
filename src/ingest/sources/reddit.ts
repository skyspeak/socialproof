import { fetchJson, fetchWithRetry, SkipSource, type IngestItem, type SourceDef } from "../adapter";

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

type RedditToken = { value: string; exp: number };
let redditToken: RedditToken | null = null;

async function redditAccess(): Promise<{
  origin: string;
  headers: Record<string, string>;
}> {
  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) {
    return { origin: "https://www.reddit.com", headers: {} };
  }

  if (!redditToken || redditToken.exp < Date.now() + 30_000) {
    const basic = Buffer.from(`${id}:${secret}`).toString("base64");
    const res = await fetchWithRetry("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      timeoutMs: 10_000,
    });
    if (!res.ok) {
      throw new SkipSource(`Reddit OAuth failed (HTTP ${res.status})`);
    }
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) {
      throw new SkipSource("Reddit OAuth returned no access_token");
    }
    redditToken = {
      value: data.access_token,
      exp: Date.now() + (data.expires_in ?? 3600) * 1000,
    };
  }

  return {
    origin: "https://oauth.reddit.com",
    headers: { authorization: `Bearer ${redditToken.value}` },
  };
}

/**
 * Reddit stands in for a chunk of the X conversation — the same arguments,
 * minus the login wall. r/LocalLLaMA in particular front-runs open-model
 * discourse by a day or two.
 *
 * Uses the public `.json` endpoints unless `REDDIT_CLIENT_ID` and
 * `REDDIT_CLIENT_SECRET` are set, in which case it uses application-only
 * OAuth against `oauth.reddit.com`. Unauthenticated reads 403 from most
 * datacenter IPs, including Vercel.
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
    const access = await redditAccess();

    for (const sub of SUBREDDITS) {
      try {
        const data = await fetchJson<RedditListing>(
          `${access.origin}/r/${sub}/top.json?t=day&limit=25`,
          { headers: access.headers, timeoutMs: 12_000 },
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
        access.origin.includes("oauth")
          ? "all subreddits unreachable despite Reddit OAuth"
          : "all subreddits unreachable (Reddit commonly returns 403 to datacenter IPs; set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET)",
      );
    }

    return items;
  },
};
