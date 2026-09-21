import { fetchJson, SkipSource, type IngestItem, type SourceDef } from "../adapter";

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
 * Unauthenticated search is limited to 10 req/min. Set GITHUB_TOKEN (a
 * fine-grained PAT with public_repo read is enough) so Vercel doesn't get 403s.
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

    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
    };
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (token) headers.authorization = `Bearer ${token}`;

    let data: SearchResponse;
    try {
      data = await fetchJson<SearchResponse>(
        `https://api.github.com/search/repositories?${params}`,
        { headers, timeoutMs: 15_000 },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/\b403\b/.test(msg) || /\b429\b/.test(msg)) {
        throw new SkipSource(
          token
            ? `GitHub search rate-limited (${msg})`
            : "GitHub search blocked unauthenticated; set GITHUB_TOKEN",
        );
      }
      throw err;
    }

    return (data.items ?? []).map<IngestItem>((r) => ({
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
