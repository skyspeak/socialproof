import { XMLParser } from "fast-xml-parser";
import { isPeopleMoveHeadline } from "@/lib/people";
import {
  fetchText,
  stripHtml,
  type IngestItem,
  type SourceDef,
} from "../adapter";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
});

type FeedEntry = {
  title?: string | { "#text"?: string };
  link?: string | { "@_href"?: string } | Array<{ "@_href"?: string; "@_rel"?: string }>;
  guid?: string | { "#text"?: string };
  id?: string;
  pubDate?: string;
  published?: string;
  updated?: string;
  description?: string;
  summary?: string | { "#text"?: string };
  content?: string | { "#text"?: string };
  "content:encoded"?: string;
  author?: string | { name?: string };
  "dc:creator"?: string;
};

function text(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "object" && "#text" in (v as Record<string, unknown>)) {
    const inner = (v as Record<string, unknown>)["#text"];
    return inner == null ? null : String(inner);
  }
  return null;
}

function firstLink(entry: FeedEntry): string | null {
  const l = entry.link;
  if (!l) return null;
  if (typeof l === "string") return l;
  if (Array.isArray(l)) {
    const alt = l.find((x) => x["@_rel"] === "alternate" && x["@_href"]) ?? l[0];
    return alt?.["@_href"] ?? null;
  }
  return l["@_href"] ?? null;
}

function entryDate(entry: FeedEntry): Date | null {
  const raw = entry.pubDate ?? entry.published ?? entry.updated;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Parse RSS 2.0 and Atom with one code path. */
export function parseFeed(xml: string): FeedEntry[] {
  const doc = parser.parse(xml) as Record<string, any>;
  const channel = doc?.rss?.channel ?? doc?.["rdf:RDF"] ?? doc?.feed;
  if (!channel) return [];
  const raw = channel.item ?? channel.entry ?? [];
  return (Array.isArray(raw) ? raw : [raw]).filter(Boolean) as FeedEntry[];
}

export function feedItems(xml: string, slugPrefix: string): IngestItem[] {
  return parseFeed(xml).map((e, i) => {
    const title = text(e.title) ?? "Untitled";
    const link = firstLink(e);
    const bodyRaw =
      e["content:encoded"] ??
      text(e.content) ??
      text(e.summary) ??
      e.description ??
      null;

    return {
      externalId:
        text(e.guid) ?? e.id ?? link ?? `${slugPrefix}-${title.slice(0, 60)}-${i}`,
      title: stripHtml(title, 300),
      url: link,
      body: bodyRaw ? stripHtml(String(bodyRaw)) : null,
      author:
        e["dc:creator"] ??
        (typeof e.author === "string" ? e.author : (e.author?.name ?? null)),
      publishedAt: entryDate(e),
    };
  });
}

/** Build a source from any RSS/Atom URL. */
export function rssSource(opts: {
  slug: string;
  name: string;
  url: string;
  tier: "core" | "x_adjacent" | "people";
  /** Feeds without reliable dates (some newsletters) skip window filtering. */
  ignoreWindow?: boolean;
  limit?: number;
}): SourceDef {
  return {
    slug: opts.slug,
    name: opts.name,
    kind: "rss",
    tier: opts.tier,
    url: opts.url,
    async fetch(window) {
      const xml = await fetchText(opts.url);
      const items = feedItems(xml, opts.slug);
      const filtered = opts.ignoreWindow
        ? items
        : items.filter((it) => {
            if (!it.publishedAt) return false;
            return it.publishedAt >= window.start && it.publishedAt <= window.end;
          });
      return filtered.slice(0, opts.limit ?? 40);
    },
  };
}

/**
 * Techmeme is the load-bearing X proxy: its river is largely driven by what
 * tech X is arguing about, and it runs a dedicated people-moves column. If
 * every direct X read path breaks, this is what keeps the X tier alive.
 */
export const techmeme = rssSource({
  slug: "techmeme",
  name: "Techmeme",
  url: "https://www.techmeme.com/feed.xml",
  tier: "x_adjacent",
  limit: 50,
});

/**
 * The people beat within Techmeme.
 *
 * Techmeme has no separate personnel feed (its `?x=1` variant returns the
 * identical document), so rather than pretend otherwise we run the main feed
 * through the personnel-shape filter. Same bytes, different lens — and because
 * it's a distinct source row, its yield is tracked independently in the run log.
 */
export const techmemePeople: SourceDef = {
  slug: "techmeme-people",
  name: "Techmeme (people moves)",
  kind: "rss",
  tier: "people",
  url: "https://www.techmeme.com/feed.xml",
  async fetch(window) {
    const xml = await fetchText("https://www.techmeme.com/feed.xml");
    return feedItems(xml, "techmeme-people")
      .filter((it) => {
        if (!it.publishedAt) return false;
        if (it.publishedAt < window.start || it.publishedAt > window.end) return false;
        return isPeopleMoveHeadline(`${it.title} ${it.body?.slice(0, 300) ?? ""}`);
      })
      .map((it) => ({ ...it, externalId: `people-${it.externalId}` }));
  },
};

/** Trade-press rivers. Window-filtered; tight limits so they cannot swamp HN. */
export const tradePress: SourceDef[] = [
  rssSource({
    slug: "arstechnica",
    name: "Ars Technica",
    url: "https://feeds.arstechnica.com/arstechnica/index",
    tier: "core",
    limit: 25,
  }),
  rssSource({
    slug: "404media",
    name: "404 Media",
    url: "https://www.404media.co/rss/",
    tier: "core",
    limit: 15,
  }),
  rssSource({
    slug: "techcrunch",
    name: "TechCrunch",
    url: "https://techcrunch.com/feed/",
    tier: "core",
    limit: 20,
  }),
  rssSource({
    slug: "theregister",
    name: "The Register",
    url: "https://www.theregister.com/headlines.atom",
    tier: "core",
    limit: 20,
  }),
  rssSource({
    slug: "mit-tr",
    name: "MIT Technology Review",
    url: "https://www.technologyreview.com/feed/",
    tier: "core",
    limit: 15,
  }),
];

/** Recap blogs and newsletters that summarize the industry argument secondhand. */
export const newsletters: SourceDef[] = [
  rssSource({
    slug: "simonwillison",
    name: "Simon Willison's Weblog",
    url: "https://simonwillison.net/atom/everything/",
    tier: "x_adjacent",
    limit: 20,
  }),
  rssSource({
    slug: "importai",
    name: "Import AI",
    url: "https://importai.substack.com/feed",
    tier: "x_adjacent",
    limit: 10,
  }),
  rssSource({
    slug: "latentspace",
    name: "Latent Space",
    url: "https://www.latent.space/feed",
    tier: "x_adjacent",
    limit: 10,
  }),
  rssSource({
    slug: "platformer",
    name: "Platformer",
    url: "https://www.platformer.news/feed",
    tier: "x_adjacent",
    limit: 10,
  }),
  rssSource({
    slug: "interconnects",
    name: "Interconnects",
    url: "https://www.interconnects.ai/feed",
    tier: "x_adjacent",
    limit: 10,
  }),
  rssSource({
    slug: "huggingface-blog",
    name: "Hugging Face Blog",
    url: "https://huggingface.co/blog/feed.xml",
    tier: "x_adjacent",
    limit: 10,
  }),
  rssSource({
    slug: "openai-news",
    name: "OpenAI News",
    url: "https://openai.com/news/rss.xml",
    tier: "x_adjacent",
    limit: 12,
  }),
  rssSource({
    slug: "theverge",
    name: "The Verge",
    url: "https://www.theverge.com/rss/index.xml",
    tier: "x_adjacent",
    limit: 25,
  }),
];
