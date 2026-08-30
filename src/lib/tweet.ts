/**
 * Parse tweet URLs and unpack FxTwitter / vxTwitter payloads into links + images.
 * Fetch lives in bookmarks.ts so this module stays unit-testable without I/O.
 */

export type CapturedTweet = {
  tweetId: string;
  tweetUrl: string;
  author: string | null;
  text: string;
  publishedAt: Date | null;
  links: string[];
  images: string[];
  likes: number | null;
  raw: Record<string, unknown>;
};

const URL_RE = /https?:\/\/[^\s<>"'`)\]\}]+/gi;

const SKIP_HOSTS = new Set([
  "t.co",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
  "x.com",
  "www.x.com",
  "pic.twitter.com",
  "pbs.twimg.com",
  "abs.twimg.com",
  "video.twimg.com",
  "ton.twitter.com",
  "fxtwitter.com",
  "api.fxtwitter.com",
  "vxtwitter.com",
  "api.vxtwitter.com",
  "nitter.net",
]);

export function parseTweetId(input: string): string | null {
  const trimmed = input.trim();
  if (/^\d{5,25}$/.test(trimmed)) return trimmed;

  const found = findTweetUrl(trimmed);
  if (!found) return null;
  try {
    const u = new URL(found);
    const m = u.pathname.match(/\/(?:i\/web\/)?status\/(\d+)/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Pull a tweet URL out of a share-sheet blob or a pasted line of text. */
export function findTweetUrl(text: string): string | null {
  const trimmed = text.trim();
  try {
    const direct = trimmed.startsWith("http") ? trimmed : `https://${trimmed}`;
    const u = new URL(direct.split(/\s+/)[0] ?? "");
    if (isTweetHost(u.hostname) && /\/status\/\d+/.test(u.pathname)) {
      return u.toString();
    }
  } catch {
    /* fall through to regex */
  }
  const matches = trimmed.match(URL_RE) ?? [];
  for (const raw of matches) {
    try {
      const u = new URL(stripTrailingPunct(raw));
      if (isTweetHost(u.hostname) && /\/status\/\d+/.test(u.pathname)) {
        return u.toString();
      }
    } catch {
      continue;
    }
  }
  return null;
}

export function tweetUrlFor(id: string, handle?: string | null): string {
  const user = handle && /^[A-Za-z0-9_]{1,15}$/.test(handle) ? handle : "i";
  return `https://x.com/${user}/status/${id}`;
}

export function isTweetHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "x.com" ||
    host === "www.x.com" ||
    host === "twitter.com" ||
    host === "www.twitter.com" ||
    host === "mobile.twitter.com" ||
    host.endsWith(".twitter.com")
  );
}

export function collectOutboundLinks(
  text: string,
  extra: Array<string | null | undefined> = [],
): string[] {
  const found = [...(text.match(URL_RE) ?? []), ...extra.filter(Boolean)];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of found) {
    const cleaned = canonicalizeOutbound(String(raw));
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out.slice(0, 8);
}

export function collectImageUrls(
  ...groups: Array<Array<string | null | undefined> | undefined>
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const raw of group ?? []) {
      if (!raw) continue;
      const url = preferLargeTwimg(stripTrailingPunct(raw));
      if (!isImageUrl(url) || seen.has(url)) continue;
      seen.add(url);
      out.push(url);
    }
  }
  return out.slice(0, 8);
}

/** Normalize FxTwitter `{ tweet }` or vxTwitter flat payloads. */
export function capturedFromAny(json: unknown): CapturedTweet | null {
  if (!json || typeof json !== "object") return null;
  const root = json as Record<string, unknown>;
  if (root.tweet && typeof root.tweet === "object") {
    return capturedFromFxTweet(root.tweet as Record<string, unknown>, root);
  }
  if (root.tweetID || root.tweetId || root.mediaURLs) {
    return capturedFromVxTweet(root);
  }
  if (root.id && (root.text || root.author)) {
    return capturedFromFxTweet(root, root);
  }
  return null;
}

function capturedFromFxTweet(
  tweet: Record<string, unknown>,
  envelope: Record<string, unknown>,
): CapturedTweet | null {
  const tweetId = String(tweet.id ?? tweet.tweet_id ?? "").replace(/\D/g, "");
  if (!tweetId) return null;

  const authorObj =
    tweet.author && typeof tweet.author === "object"
      ? (tweet.author as Record<string, unknown>)
      : {};
  const handle = str(authorObj.screen_name ?? authorObj.screenName);
  const text = str(tweet.text ?? tweet.full_text) ?? "";
  const quote =
    tweet.quote && typeof tweet.quote === "object"
      ? (tweet.quote as Record<string, unknown>)
      : null;
  const quoteAuthor =
    quote?.author && typeof quote.author === "object"
      ? str((quote.author as Record<string, unknown>).screen_name)
      : null;
  const quoteText = quote ? str(quote.text) : null;
  const body =
    quoteText && quoteText !== text
      ? `${text}\n\nQT @${quoteAuthor ?? "unknown"}: ${quoteText}`.trim()
      : text;

  const media = asRecord(tweet.media);
  const quoteMedia = quote ? asRecord(quote.media) : null;
  const extraUrls = [
    ...(asStringArray(tweet.external_urls) ?? []),
    ...(asStringArray(tweet.externalUrls) ?? []),
    ...entityUrls(tweet),
    ...(quote ? entityUrls(quote) : []),
    ...(quote ? asStringArray(quote.external_urls) ?? [] : []),
  ];

  const images = collectImageUrls(
    photoUrls(media),
    videoThumbs(media),
    quoteMedia ? photoUrls(quoteMedia) : undefined,
    quoteMedia ? videoThumbs(quoteMedia) : undefined,
    walkTwimg(tweet),
  );

  const links = collectOutboundLinks(`${body} ${text}`, extraUrls);

  return {
    tweetId,
    tweetUrl: str(tweet.url) ?? tweetUrlFor(tweetId, handle),
    author: handle ?? str(authorObj.name),
    text: body,
    publishedAt: parseDate(tweet.created_at ?? tweet.createdAt ?? tweet.date),
    links,
    images,
    likes: num(tweet.likes ?? tweet.favorite_count),
    raw: envelope,
  };
}

function capturedFromVxTweet(tweet: Record<string, unknown>): CapturedTweet | null {
  const tweetId = String(tweet.tweetID ?? tweet.tweetId ?? tweet.id ?? "").replace(
    /\D/g,
    "",
  );
  if (!tweetId) return null;
  const handle = str(tweet.user_name ?? tweet.userName ?? tweet.screen_name);
  const text = str(tweet.text) ?? "";
  const extended = Array.isArray(tweet.media_extended)
    ? tweet.media_extended
    : [];
  const extendedUrls = extended
    .map((m) => {
      if (!m || typeof m !== "object") return null;
      const rec = m as Record<string, unknown>;
      if (rec.type === "image" || rec.type === "gif") return str(rec.url);
      return str(rec.thumbnail_url ?? rec.thumbnailUrl);
    })
    .filter((u): u is string => Boolean(u));

  const images = collectImageUrls(
    asStringArray(tweet.mediaURLs),
    extendedUrls,
    walkTwimg(tweet),
  );
  const links = collectOutboundLinks(text, asStringArray(tweet.qrtURL) ?? []);

  return {
    tweetId,
    tweetUrl: str(tweet.tweetURL ?? tweet.tweetUrl) ?? tweetUrlFor(tweetId, handle),
    author: handle,
    text,
    publishedAt: parseDate(tweet.date ?? tweet.created_at),
    links,
    images,
    likes: num(tweet.likes),
    raw: tweet,
  };
}

function canonicalizeOutbound(raw: string): string | null {
  try {
    const u = new URL(stripTrailingPunct(raw));
    const host = u.hostname.toLowerCase();
    if (SKIP_HOSTS.has(host)) return null;
    if (isTweetHost(host) && /\/status\//.test(u.pathname)) return null;
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

function isImageUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host.includes("twimg.com") || host.includes("twitter.com")) {
      return /\/media\/|format=jpg|format=png|format=webp|\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(
        `${u.pathname}${u.search}`,
      );
    }
    return /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(u.pathname);
  } catch {
    return false;
  }
}

function preferLargeTwimg(url: string): string {
  try {
    const u = new URL(url);
    if (!u.hostname.includes("twimg.com")) return url;
    if (u.searchParams.has("name")) u.searchParams.set("name", "large");
    return u.toString();
  } catch {
    return url;
  }
}

function photoUrls(media: Record<string, unknown> | null): string[] {
  if (!media) return [];
  const photos = Array.isArray(media.photos) ? media.photos : [];
  return photos
    .map((p) => (p && typeof p === "object" ? str((p as Record<string, unknown>).url) : null))
    .filter((u): u is string => Boolean(u));
}

function videoThumbs(media: Record<string, unknown> | null): string[] {
  if (!media) return [];
  const videos = Array.isArray(media.videos) ? media.videos : [];
  return videos
    .map((v) => {
      if (!v || typeof v !== "object") return null;
      const rec = v as Record<string, unknown>;
      return str(rec.thumbnail_url ?? rec.thumbnailUrl ?? rec.preview_image_url);
    })
    .filter((u): u is string => Boolean(u));
}

function entityUrls(tweet: Record<string, unknown>): string[] {
  const entities = asRecord(tweet.entities);
  const urls = entities && Array.isArray(entities.urls) ? entities.urls : [];
  return urls
    .map((u) => {
      if (!u || typeof u !== "object") return null;
      const rec = u as Record<string, unknown>;
      return str(rec.expanded_url ?? rec.unwound_url ?? rec.url);
    })
    .filter((u): u is string => Boolean(u));
}

function walkTwimg(node: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 6 || node == null) return out;
  if (typeof node === "string") {
    if (node.includes("pbs.twimg.com") && /\/media\//.test(node)) out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const v of node) walkTwimg(v, depth + 1, out);
    return out;
  }
  if (typeof node === "object") {
    for (const v of Object.values(node as Record<string, unknown>)) {
      walkTwimg(v, depth + 1, out);
    }
  }
  return out;
}

function stripTrailingPunct(raw: string): string {
  return raw.replace(/[.,;:!?)]+$/g, "");
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t || null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === "string");
}
