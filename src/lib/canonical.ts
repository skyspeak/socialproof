import { createHash } from "node:crypto";

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "ref",
  "ref_src",
  "ref_url",
  "source",
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "s",
  "t",
  "cmpid",
  "smid",
]);

/** Hosts whose "same story" lives at a canonical id we can normalize toward. */
const HOST_ALIASES: Record<string, string> = {
  "www.x.com": "x.com",
  "twitter.com": "x.com",
  "www.twitter.com": "x.com",
  "mobile.twitter.com": "x.com",
  "nitter.net": "x.com",
  "xcancel.com": "x.com",
  "www.github.com": "github.com",
  "amp.theguardian.com": "www.theguardian.com",
};

/**
 * Reduce a URL to a stable identity so the same story arriving from HN, Reddit
 * and a newsletter collapses into one item.
 */
export function canonicalizeUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  let raw = input.trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }

  u.protocol = "https:";
  u.hash = "";

  let host = u.hostname.toLowerCase();
  host = HOST_ALIASES[host] ?? host;
  if (host.startsWith("www.") && !HOST_ALIASES[u.hostname.toLowerCase()]) {
    host = host.slice(4);
  }
  u.hostname = host;
  u.port = "";

  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) u.searchParams.delete(key);
  }
  u.searchParams.sort();

  // Trailing slash is not meaningful for identity, except at the root.
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.replace(/\/+$/, "");
  }

  const qs = u.searchParams.toString();
  return `https://${u.hostname}${u.pathname}${qs ? `?${qs}` : ""}`;
}

/** Normalize a title for fuzzy cross-source matching. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(the|a|an|and|or|of|to|in|on|for|with|is|are|how|why)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Content hash over the normalized title (plus a body prefix when present).
 * Catches the same story submitted under different URLs.
 */
export function contentHash(title: string, body?: string | null): string {
  const basis = normalizeTitle(title) + "|" + normalizeTitle(body?.slice(0, 400) ?? "");
  return createHash("sha256").update(basis).digest("hex").slice(0, 32);
}

/** Cheap token-overlap similarity, used to merge near-duplicate titles. */
export function titleSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeTitle(a).split(" ").filter(Boolean));
  const tb = new Set(normalizeTitle(b).split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const tok of ta) if (tb.has(tok)) shared++;
  return shared / Math.min(ta.size, tb.size);
}
