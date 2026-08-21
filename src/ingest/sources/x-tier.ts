import {
  fetchJson,
  fetchText,
  stripHtml,
  SkipSource,
  type IngestItem,
  type SourceDef,
} from "../adapter";
import { feedItems } from "./rss";

type ExaResult = {
  id?: string;
  url: string;
  title?: string | null;
  text?: string | null;
  author?: string | null;
  publishedDate?: string | null;
  score?: number;
};

type ExaResponse = { results: ExaResult[] };

async function exaSearch(body: Record<string, unknown>): Promise<ExaResult[]> {
  const key = process.env.EXA_API_KEY;
  if (!key) throw new SkipSource("EXA_API_KEY not set");

  const data = await fetchJson<ExaResponse>("https://api.exa.ai/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify(body),
    timeoutMs: 25_000,
  });
  return data.results ?? [];
}

/**
 * Semantic search scoped to x.com. This is the closest thing to reading the
 * timeline without an account: Exa's index carries public post text, so we get
 * the actual argument rather than a secondhand summary.
 */
export const exaX: SourceDef = {
  slug: "exa-x",
  name: "X via Exa (semantic)",
  kind: "exa_x",
  tier: "x_adjacent",
  async fetch(window) {
    const results = await exaSearch({
      query:
        "significant discussion among AI researchers, engineers and founders about new models, tools, releases or industry shifts",
      category: "tweet",
      numResults: 30,
      includeDomains: ["x.com", "twitter.com"],
      startPublishedDate: window.start.toISOString(),
      endPublishedDate: window.end.toISOString(),
      contents: { text: { maxCharacters: 1200 } },
    });

    return results.map<IngestItem>((r) => ({
      externalId: r.id ?? r.url,
      title: stripHtml(r.title || r.text?.slice(0, 180) || r.url, 300),
      url: r.url,
      body: r.text ? stripHtml(r.text) : null,
      author: r.author ?? null,
      publishedAt: r.publishedDate ? new Date(r.publishedDate) : null,
      raw: { relevance: r.score },
    }));
  },
};

/**
 * The people beat, run through Exa across X, LinkedIn and news. Announcement
 * posts ("excited to share that I'm joining…", "after N years, I'm leaving…")
 * are a formulaic genre, which makes them unusually tractable for semantic search.
 */
export const exaPeopleMoves: SourceDef = {
  slug: "exa-people",
  name: "People moves via Exa",
  kind: "exa_x",
  tier: "people",
  async fetch(window) {
    const queries = [
      "announcing I am leaving my role at a major tech or AI company",
      "excited to announce I am joining a new company as an executive or researcher",
      "tech executive steps down or departs, leadership change announcement",
      "notable engineer or researcher starting a new startup out of stealth",
    ];

    const seen = new Map<string, IngestItem>();
    for (const query of queries) {
      try {
        const results = await exaSearch({
          query,
          numResults: 12,
          startPublishedDate: window.start.toISOString(),
          endPublishedDate: window.end.toISOString(),
          contents: { text: { maxCharacters: 1000 } },
        });

        for (const r of results) {
          if (seen.has(r.url)) continue;
          seen.set(r.url, {
            externalId: `exa-people-${r.id ?? r.url}`,
            title: stripHtml(r.title || r.text?.slice(0, 180) || r.url, 300),
            url: r.url,
            body: r.text ? stripHtml(r.text) : null,
            author: r.author ?? null,
            publishedAt: r.publishedDate ? new Date(r.publishedDate) : null,
            raw: { matchedQuery: query },
          });
        }
      } catch (err) {
        if (err instanceof SkipSource) throw err;
        continue;
      }
    }
    return [...seen.values()];
  },
};

/**
 * Nitter-style mirrors expose per-account RSS without a login. Instances die
 * constantly, so we race a list and take the first that answers — and if the
 * whole list is down, we skip rather than fail, because Techmeme and the
 * newsletters still carry the X conversation secondhand.
 */
const MIRROR_HOSTS = [
  "https://nitter.privacydev.net",
  "https://xcancel.com",
  "https://nitter.poast.org",
];

const WATCHED_ACCOUNTS = [
  "karpathy",
  "sama",
  "simonw",
  "swyx",
  "emollick",
];

export const xMirrors: SourceDef = {
  slug: "x-mirrors",
  name: "X via public mirrors",
  kind: "exa_x",
  tier: "x_adjacent",
  async fetch(window) {
    let host: string | null = null;

    for (const candidate of MIRROR_HOSTS) {
      try {
        const probe = await fetchText(`${candidate}/${WATCHED_ACCOUNTS[0]}/rss`, {
          timeoutMs: 8_000,
          retries: 0,
        });
        if (probe.includes("<rss") || probe.includes("<feed")) {
          host = candidate;
          break;
        }
      } catch {
        continue;
      }
    }

    if (!host) {
      throw new SkipSource("no reachable X mirror instance");
    }

    const items: IngestItem[] = [];
    for (const account of WATCHED_ACCOUNTS) {
      try {
        const xml = await fetchText(`${host}/${account}/rss`, {
          timeoutMs: 10_000,
          retries: 0,
        });
        for (const item of feedItems(xml, `x-${account}`)) {
          if (
            item.publishedAt &&
            (item.publishedAt < window.start || item.publishedAt > window.end)
          ) {
            continue;
          }
          items.push({ ...item, author: account, raw: { mirror: host } });
        }
      } catch {
        continue;
      }
    }
    return items;
  },
};
