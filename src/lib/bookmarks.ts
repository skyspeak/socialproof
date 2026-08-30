import { createHash } from "node:crypto";
import { and, gte, inArray, lte } from "drizzle-orm";
import { getDb } from "@/db";
import { bookmarks, type Bookmark } from "@/db/schema";
import {
  fetchJson,
  fetchText,
  stripHtml,
  type IngestItem,
} from "@/ingest/adapter";
import type { Window } from "@/lib/window";
import {
  capturedFromAny,
  parseTweetId,
  tweetUrlFor,
  type CapturedTweet,
} from "@/lib/tweet";

const FX_URL = (id: string) => `https://api.fxtwitter.com/status/${id}`;
const VX_URL = (id: string) => `https://api.vxtwitter.com/Twitter/status/${id}`;

export type BookmarkCapture = {
  tweetId: string;
  tweetUrl: string;
  author: string | null;
  text: string | null;
  publishedAt: Date | null;
  capturedAt: Date;
  links: string[];
  images: string[];
};

export async function fetchTweet(id: string): Promise<CapturedTweet> {
  const errors: string[] = [];
  for (const url of [FX_URL(id), VX_URL(id)]) {
    try {
      const json = await fetchJson<unknown>(url, { timeoutMs: 12_000, retries: 1 });
      const captured = capturedFromAny(json);
      if (captured) return captured;
      errors.push(`${url}: unrecognised payload`);
    } catch (err) {
      errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`Could not fetch tweet ${id} (${errors.join("; ")})`);
}

async function enrichLinkTitles(
  links: string[],
): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  await Promise.all(
    links.slice(0, 5).map(async (url) => {
      try {
        const html = await fetchText(url, { timeoutMs: 6_000, retries: 0 });
        const og =
          html.match(
            /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i,
          ) ??
          html.match(
            /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i,
          );
        const titleTag = html.match(/<title[^>]*>([^<]+)/i);
        const title = stripHtml(og?.[1] || titleTag?.[1] || "", 180);
        if (title) titles.set(url, title);
      } catch {
        /* title is optional */
      }
    }),
  );
  return titles;
}

/**
 * Persist a tweet plus the outbound links and images unpacked from it.
 * Re-saving refreshes capturedAt so it belongs to today's window.
 */
export async function captureBookmark(input: string): Promise<BookmarkCapture> {
  const tweetId = parseTweetId(input);
  if (!tweetId) {
    throw new BookmarkError(
      "not_a_tweet",
      "That doesn't look like a tweet URL. Open a post on x.com and try again.",
    );
  }

  let tweet: CapturedTweet;
  try {
    tweet = await fetchTweet(tweetId);
  } catch (err) {
    throw new BookmarkError(
      "fetch_failed",
      err instanceof Error ? err.message : String(err),
    );
  }
  const titles = await enrichLinkTitles(tweet.links);
  const raw = {
    ...tweet.raw,
    linkTitles: Object.fromEntries(titles),
  };

  const db = await getDb();
  const [row] = await db
    .insert(bookmarks)
    .values({
      tweetId: tweet.tweetId,
      tweetUrl: tweet.tweetUrl,
      author: tweet.author,
      text: tweet.text || null,
      publishedAt: tweet.publishedAt,
      capturedAt: new Date(),
      links: tweet.links,
      images: tweet.images,
      raw,
    })
    .onConflictDoUpdate({
      target: bookmarks.tweetId,
      set: {
        tweetUrl: tweet.tweetUrl,
        author: tweet.author,
        text: tweet.text || null,
        publishedAt: tweet.publishedAt,
        capturedAt: new Date(),
        links: tweet.links,
        images: tweet.images,
        raw,
      },
    })
    .returning();

  return toCapture(row);
}

export async function listBookmarksInWindow(
  window: Window,
): Promise<Bookmark[]> {
  const db = await getDb();
  const slack = 3_600_000;
  return db
    .select()
    .from(bookmarks)
    .where(
      and(
        gte(bookmarks.capturedAt, new Date(window.start.getTime() - slack)),
        lte(bookmarks.capturedAt, new Date(window.end.getTime() + slack)),
      ),
    );
}

/**
 * Pull native X bookmarks when a user-context token is configured, then
 * capture any tweet we have not already stored. Existing rows are left
 * alone so they do not reappear in every subsequent issue.
 */
export async function syncNativeXBookmarks(): Promise<number> {
  const token = process.env.X_BOOKMARKS_TOKEN;
  const userId = process.env.X_USER_ID;
  if (!token || !userId) return 0;

  const data = await fetchJson<{ data?: Array<{ id?: string }> }>(
    `https://api.x.com/2/users/${encodeURIComponent(userId)}/bookmarks?max_results=50`,
    {
      headers: { authorization: `Bearer ${token}` },
      timeoutMs: 15_000,
      retries: 1,
    },
  );

  const ids = (data.data ?? [])
    .map((t) => t.id)
    .filter((id): id is string => Boolean(id));
  if (!ids.length) return 0;

  const db = await getDb();
  const existing = await db
    .select({ tweetId: bookmarks.tweetId })
    .from(bookmarks)
    .where(inArray(bookmarks.tweetId, ids));
  const known = new Set(existing.map((r) => r.tweetId));

  let added = 0;
  for (const id of ids) {
    if (known.has(id)) continue;
    if (added >= 15) break;
    try {
      await captureBookmark(tweetUrlFor(id));
      added++;
    } catch {
      /* one dead tweet should not fail the source */
    }
  }
  return added;
}

export function bookmarksToIngestItems(rows: Bookmark[]): IngestItem[] {
  const items: IngestItem[] = [];
  for (const row of rows) {
    items.push(...bookmarkToIngestItems(row));
  }
  return items;
}

export function bookmarkToIngestItems(row: Bookmark): IngestItem[] {
  const capturedAt = row.capturedAt;
  const author = row.author ? `@${row.author.replace(/^@/, "")}` : "a bookmarked tweet";
  const text = row.text?.trim() ?? "";
  const excerpt = text.slice(0, 280);
  const linkTitles =
    row.raw && typeof row.raw.linkTitles === "object" && row.raw.linkTitles
      ? (row.raw.linkTitles as Record<string, string>)
      : {};

  const items: IngestItem[] = [
    {
      externalId: row.tweetId,
      title: excerpt
        ? `${author}: ${excerpt}`
        : `Bookmarked tweet from ${author}`,
      url: row.tweetUrl,
      body: text || null,
      author: row.author,
      score: 600,
      publishedAt: capturedAt,
      discussionUrl: row.tweetUrl,
      raw: {
        kind: "tweet",
        tweetId: row.tweetId,
        imageUrl: row.images[0] ?? null,
        images: row.images,
        links: row.links,
      },
    },
  ];

  for (const url of row.links) {
    const host = hostnameOf(url);
    const titled = linkTitles[url];
    items.push({
      externalId: `link-${row.tweetId}-${shortHash(url)}`,
      title: titled ?? `Link from ${author}${host ? ` · ${host}` : ""}`,
      url,
      body: text ? `Saved from ${author}: ${excerpt}` : `Saved from ${author}`,
      author: row.author,
      score: 450,
      publishedAt: capturedAt,
      discussionUrl: row.tweetUrl,
      raw: { kind: "link", tweetId: row.tweetId, fromTweet: row.tweetUrl },
    });
  }

  for (const imageUrl of row.images) {
    items.push({
      externalId: `img-${row.tweetId}-${shortHash(imageUrl)}`,
      title: `Image from ${author}`,
      url: imageUrl,
      body: text || null,
      author: row.author,
      score: 350,
      publishedAt: capturedAt,
      discussionUrl: row.tweetUrl,
      raw: {
        kind: "image",
        tweetId: row.tweetId,
        imageUrl,
        fromTweet: row.tweetUrl,
      },
    });
  }

  return items;
}

export class BookmarkError extends Error {
  constructor(
    public readonly code: "not_a_tweet" | "fetch_failed",
    message: string,
  ) {
    super(message);
    this.name = "BookmarkError";
  }
}

function toCapture(row: Bookmark): BookmarkCapture {
  return {
    tweetId: row.tweetId,
    tweetUrl: row.tweetUrl,
    author: row.author,
    text: row.text,
    publishedAt: row.publishedAt,
    capturedAt: row.capturedAt,
    links: row.links ?? [],
    images: row.images ?? [],
  };
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
