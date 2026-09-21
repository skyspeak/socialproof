import { fetchJson, SkipSource, type IngestItem, type SourceDef } from "../adapter";

type BskyPost = {
  uri: string;
  indexedAt?: string;
  likeCount?: number;
  replyCount?: number;
  author?: { handle?: string; displayName?: string };
  record?: { text?: string; createdAt?: string };
};

type BskyFeed = { feed?: Array<{ post?: BskyPost }> };

/**
 * Public Bluesky feeds for the same people the X-mirror path watches.
 * Nitter-style hosts die constantly; this API does not need a login and is
 * the durable open-web substitute for those accounts.
 */
const ACTORS = [
  "karpathy.bsky.social",
  "simonwillison.net",
  "swyx.io",
  "emollick.bsky.social",
];

export const blueskyWatched: SourceDef = {
  slug: "bsky",
  name: "Bluesky (watched accounts)",
  kind: "bsky",
  tier: "x_adjacent",
  url: "https://bsky.app",
  async fetch(window) {
    const items: IngestItem[] = [];
    let failures = 0;

    for (const actor of ACTORS) {
      try {
        const data = await fetchJson<BskyFeed>(
          `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(actor)}&limit=30`,
          { timeoutMs: 10_000, retries: 1 },
        );
        for (const row of data.feed ?? []) {
          const post = row.post;
          if (!post?.uri) continue;
          const createdRaw = post.record?.createdAt ?? post.indexedAt;
          const at = createdRaw ? new Date(createdRaw) : null;
          if (!at || Number.isNaN(at.getTime())) continue;
          if (at < window.start || at > window.end) continue;
          const text = (post.record?.text ?? "").trim();
          if (text.length < 40) continue;

          const rkey = post.uri.split("/").pop() ?? post.uri;
          const handle = post.author?.handle ?? actor;
          items.push({
            externalId: post.uri,
            title: text.slice(0, 180).replace(/\s+/g, " "),
            url: `https://bsky.app/profile/${handle}/post/${rkey}`,
            body: text.slice(0, 1200),
            author: post.author?.displayName ?? handle,
            score: post.likeCount ?? null,
            commentCount: post.replyCount ?? null,
            publishedAt: at,
            raw: { actor, uri: post.uri },
          });
        }
      } catch {
        failures++;
      }
    }

    if (failures === ACTORS.length) {
      throw new SkipSource("Bluesky public API unreachable for all watched accounts");
    }
    return items;
  },
};
