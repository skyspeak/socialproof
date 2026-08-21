import type { Window } from "@/lib/window";

/** Normalized shape every adapter must produce. */
export type IngestItem = {
  externalId: string;
  title: string;
  url?: string | null;
  body?: string | null;
  author?: string | null;
  score?: number | null;
  commentCount?: number | null;
  discussionUrl?: string | null;
  publishedAt?: Date | null;
  raw?: Record<string, unknown>;
};

export type SourceDef = {
  slug: string;
  name: string;
  kind: string;
  tier: "core" | "x_adjacent" | "people";
  url?: string;
  config?: Record<string, unknown>;
  /** Adapters receive the window and return normalized items. */
  fetch: (window: Window) => Promise<IngestItem[]>;
};

/**
 * Thrown when a source can't run for a benign, known reason (missing optional
 * API key, all mirrors down). The runner records these as `skipped` rather than
 * `failed` so genuine breakage stays visible in the run log.
 */
export class SkipSource extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "SkipSource";
  }
}

export class SourceError extends Error {
  constructor(
    public readonly slug: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

const USER_AGENT =
  "trendwire/0.1 (+daily tech digest; contact via site) node-fetch";

/** Fetch with a timeout, one retry on transient failure, and a sane UA. */
export async function fetchWithRetry(
  url: string,
  init: FetchInit = {},
): Promise<Response> {
  const { timeoutMs = 15_000, retries = 1, ...rest } = init;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...rest,
        signal: controller.signal,
        headers: {
          "user-agent": USER_AGENT,
          accept: "application/json, text/html, application/xml;q=0.9, */*;q=0.8",
          ...(rest.headers ?? {}),
        },
      });
      clearTimeout(timer);
      // Retry only on transient server-side conditions.
      if (res.status >= 500 || res.status === 429) {
        lastError = new Error(`HTTP ${res.status}`);
        if (attempt < retries) {
          await sleep(600 * (attempt + 1));
          continue;
        }
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      if (attempt < retries) {
        await sleep(600 * (attempt + 1));
        continue;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export type FetchInit = RequestInit & { timeoutMs?: number; retries?: number };

export async function fetchJson<T>(url: string, init?: FetchInit): Promise<T> {
  const res = await fetchWithRetry(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
}

export async function fetchText(url: string, init?: FetchInit): Promise<string> {
  const res = await fetchWithRetry(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Strip tags/entities from feed HTML without pulling in a parser dependency. */
export function stripHtml(input: string, limit = 1200): string {
  const text = input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&hellip;/g, "…")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
