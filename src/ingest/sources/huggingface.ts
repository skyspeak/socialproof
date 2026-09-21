import { fetchJson, stripHtml, type IngestItem, type SourceDef } from "../adapter";

type HfPaper = {
  id?: string;
  title?: string;
  summary?: string;
  upvotes?: number;
  authors?: Array<{ name?: string }>;
  publishedAt?: string;
};

type HfDailyPaper = {
  paper?: HfPaper;
  title?: string;
  summary?: string;
  publishedAt?: string;
  numComments?: number;
};

/**
 * Hugging Face's daily papers list is a curated leading indicator: not the
 * full arXiv firehose, the handful the research community actually clicked.
 * 48h lookback because the feature date can lag submission by a day.
 */
const LOOKBACK_HOURS = 48;

export const huggingfacePapers: SourceDef = {
  slug: "huggingface-papers",
  name: "Hugging Face Daily Papers",
  kind: "huggingface",
  tier: "core",
  url: "https://huggingface.co/papers",
  async fetch(window) {
    const rows = await fetchJson<HfDailyPaper[]>(
      "https://huggingface.co/api/daily_papers",
    );
    const earliest = new Date(window.end.getTime() - LOOKBACK_HOURS * 3600 * 1000);

    const items: IngestItem[] = [];
    for (const row of rows ?? []) {
      const paper = row.paper ?? {};
      const publishedRaw = row.publishedAt ?? paper.publishedAt;
      const published = publishedRaw ? new Date(publishedRaw) : null;
      if (!published || Number.isNaN(published.getTime())) continue;
      if (published < earliest || published > window.end) continue;

      const id = paper.id ?? row.title ?? published.toISOString();
      const title = paper.title ?? row.title ?? "Untitled paper";
      const authors = (paper.authors ?? [])
        .map((a) => a.name)
        .filter((n): n is string => Boolean(n));

      items.push({
        externalId: String(id),
        title: stripHtml(title, 300),
        url: paper.id
          ? `https://arxiv.org/abs/${paper.id}`
          : "https://huggingface.co/papers",
        body: stripHtml(paper.summary ?? row.summary ?? "", 1200) || null,
        author: authors.slice(0, 4).join(", ") || null,
        score: paper.upvotes ?? null,
        commentCount: row.numComments ?? null,
        discussionUrl: paper.id
          ? `https://huggingface.co/papers/${paper.id}`
          : null,
        publishedAt: published,
        raw: { authorCount: authors.length },
      });
    }
    return items.slice(0, 25);
  },
};
