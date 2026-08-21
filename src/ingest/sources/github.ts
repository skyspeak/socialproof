import { fetchJson, type IngestItem, type SourceDef } from "../adapter";

type SearchResponse = {
  items: Array<{
    id: number;
    full_name: string;
    html_url: string;
    description: string | null;
    stargazers_count: number;
    language: string | null;
    created_at: string;
    pushed_at: string;
    owner?: { login: string };
    topics?: string[];
  }>;
};

/**
 * GitHub has no official "trending" API, so we approximate it: repos created
 * in the last ~2 weeks sorted by stars. That biases toward genuinely new
 * projects rather than perennial giants, which is what a daily digest wants.
 *
 * Unauthenticated search is limited to 10 req/min — fine for one call a day.
 */
export const githubTrending: SourceDef = {
  slug: "github-trending",
  name: "GitHub (new + rising)",
  kind: "github",
  tier: "core",
  url: "https://github.com",
  async fetch(window) {
    const since = new Date(window.end.getTime() - 14 * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);

    const params = new URLSearchParams({
      q: `created:>${since} stars:>150`,
      sort: "stars",
      order: "desc",
      per_page: "25",
    });

    const data = await fetchJson<SearchResponse>(
      `https://api.github.com/search/repositories?${params}`,
      { headers: { accept: "application/vnd.github+json" } },
    );

    return data.items.map<IngestItem>((r) => ({
      externalId: String(r.id),
      title: `${r.full_name} — ${r.description ?? "no description"}`.slice(0, 300),
      url: r.html_url,
      body: r.description,
      author: r.owner?.login ?? null,
      score: r.stargazers_count,
      publishedAt: new Date(r.created_at),
      raw: { language: r.language, topics: r.topics, pushedAt: r.pushed_at },
    }));
  },
};
