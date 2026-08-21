import { fetchText, stripHtml, type IngestItem, type SourceDef } from "../adapter";
import { parseFeed } from "./rss";

/**
 * Recent AI/ML submissions. The arXiv API returns Atom, so we reuse the feed
 * parser and just query its search endpoint with a category filter.
 *
 * Papers rarely "trend" on the day they post, but they're the leading
 * indicator for what the discourse argues about a week later.
 *
 * Window note: arXiv does not announce on weekends, so a strict 24h window
 * returns nothing every Saturday and Sunday. Since papers are a leading
 * indicator rather than breaking news, this source uses a wider lookback and
 * lets dedup handle the overlap between consecutive days.
 */
const LOOKBACK_HOURS = 96;

export const arxiv: SourceDef = {
  slug: "arxiv",
  name: "arXiv (cs.AI / cs.LG / cs.CL)",
  kind: "arxiv",
  tier: "core",
  url: "https://arxiv.org",
  async fetch(window) {
    const params = new URLSearchParams({
      search_query: "cat:cs.AI OR cat:cs.LG OR cat:cs.CL",
      sortBy: "submittedDate",
      sortOrder: "descending",
      max_results: "40",
    });

    const xml = await fetchText(`https://export.arxiv.org/api/query?${params}`);
    const entries = parseFeed(xml);

    const earliest = new Date(
      window.end.getTime() - LOOKBACK_HOURS * 60 * 60 * 1000,
    );

    const items: IngestItem[] = [];
    for (const e of entries) {
      const anyEntry = e as Record<string, any>;
      const published = anyEntry.published ? new Date(anyEntry.published) : null;
      if (!published || published < earliest || published > window.end) continue;

      const id: string = anyEntry.id ?? "";
      const title =
        typeof anyEntry.title === "string"
          ? anyEntry.title
          : (anyEntry.title?.["#text"] ?? "Untitled");
      const authors = anyEntry.author
        ? (Array.isArray(anyEntry.author) ? anyEntry.author : [anyEntry.author])
            .map((a: any) => a?.name)
            .filter(Boolean)
        : [];

      items.push({
        externalId: id || title,
        title: stripHtml(title, 300),
        url: id || null,
        body: anyEntry.summary ? stripHtml(String(anyEntry.summary)) : null,
        author: authors.slice(0, 4).join(", ") || null,
        publishedAt: published,
        raw: { authorCount: authors.length },
      });
    }
    return items;
  },
};
