import { fetchJson, type IngestItem, type SourceDef } from "../adapter";

type LobstersStory = {
  short_id: string;
  title: string;
  url: string;
  score: number;
  comment_count: number;
  created_at: string;
  comments_url: string;
  submitter_user?: string | { username?: string };
  description_plain?: string;
  tags?: string[];
};

/**
 * Lobsters skews deeper-technical than HN and surfaces systems/language work
 * that never reaches the HN front page. Small but high signal-to-noise.
 */
export const lobsters: SourceDef = {
  slug: "lobsters",
  name: "Lobsters",
  kind: "lobsters",
  tier: "core",
  url: "https://lobste.rs",
  async fetch(window) {
    const stories = await fetchJson<LobstersStory[]>("https://lobste.rs/hottest.json");

    return stories
      .map((s) => ({ s, at: new Date(s.created_at) }))
      .filter(({ at }) => at >= window.start && at <= window.end)
      .map<IngestItem>(({ s, at }) => ({
        externalId: s.short_id,
        title: s.title,
        url: s.url || s.comments_url,
        body: s.description_plain || null,
        author:
          typeof s.submitter_user === "string"
            ? s.submitter_user
            : (s.submitter_user?.username ?? null),
        score: s.score,
        commentCount: s.comment_count,
        discussionUrl: s.comments_url,
        publishedAt: at,
        raw: { tags: s.tags },
      }));
  },
};
