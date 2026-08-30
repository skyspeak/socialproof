/**
 * Bookmarks: tweet URL parsing, link/image unpacking, ingest item shape,
 * and corpus seats for the saved tier.
 *
 *   npx tsx scripts/test-bookmarks.ts
 */
import assert from "node:assert";
import { capturedFromAny, collectOutboundLinks, parseTweetId } from "../src/lib/tweet";
import { bookmarkToIngestItems } from "../src/lib/bookmarks";
import { selectCorpus } from "../src/synth/index";
import type { Bookmark } from "../src/db/schema";
import type { DedupedItem } from "../src/ingest/run";

const FX = {
  code: 200,
  tweet: {
    id: "1234567890",
    url: "https://twitter.com/demo/status/1234567890",
    text: "New paper worth reading https://arxiv.org/abs/2401.00001 and a t.co leftover https://t.co/abcd",
    created_at: "2026-08-22T12:00:00Z",
    likes: 42,
    author: { screen_name: "demo", name: "Demo" },
    external_urls: ["https://arxiv.org/abs/2401.00001"],
    media: {
      photos: [
        { url: "https://pbs.twimg.com/media/ABC123?format=jpg&name=small" },
      ],
    },
    quote: {
      text: "The chart https://example.com/chart",
      author: { screen_name: "quoted" },
      media: {
        photos: [{ url: "https://pbs.twimg.com/media/QUOTE1?format=jpg&name=orig" }],
      },
    },
  },
};

const VX = {
  tweetID: "999",
  user_name: "vxuser",
  text: "Ship notes https://github.com/acme/ship",
  date: "Sat Aug 22 12:00:00 +0000 2026",
  tweetURL: "https://twitter.com/vxuser/status/999",
  mediaURLs: ["https://pbs.twimg.com/media/VXIMG.jpg"],
};

function item(
  partial: Partial<DedupedItem> & { id: string; title: string },
): DedupedItem {
  return {
    url: null,
    body: null,
    author: null,
    score: 1,
    commentCount: null,
    velocity: null,
    discussionUrl: null,
    publishedAt: null,
    sourceSlug: "core",
    tier: "core",
    duplicateCount: 1,
    alsoSeenIn: [],
    ...partial,
  };
}

async function main() {
  const checks: Array<[string, boolean]> = [];

  checks.push([
    "parseTweetId accepts x.com /status URLs",
    parseTweetId("https://x.com/foo/status/1234567890") === "1234567890",
  ]);
  checks.push([
    "parseTweetId accepts /i/web/status and query strings",
    parseTweetId("https://x.com/i/web/status/99?s=20") === "99",
  ]);
  checks.push([
    "parseTweetId accepts a bare status id",
    parseTweetId("1234567890") === "1234567890",
  ]);
  checks.push([
    "parseTweetId rejects a non-tweet URL",
    parseTweetId("https://news.ycombinator.com/item?id=1") === null,
  ]);

  const outbound = collectOutboundLinks(
    "see https://arxiv.org/abs/1 and https://t.co/x and https://x.com/a/status/1",
    ["https://example.com/doc"],
  );
  checks.push([
    "outbound links keep real URLs and drop t.co / tweet permalinks",
    outbound.includes("https://arxiv.org/abs/1") &&
      outbound.includes("https://example.com/doc") &&
      !outbound.some((u) => u.includes("t.co") || u.includes("x.com")),
  ]);

  const fx = capturedFromAny(FX);
  checks.push(["FxTwitter payload yields a tweet id", fx?.tweetId === "1234567890"]);
  checks.push(["FxTwitter keeps the arxiv link", Boolean(fx?.links.includes("https://arxiv.org/abs/2401.00001"))]);
  checks.push(["FxTwitter drops t.co", Boolean(fx && !fx.links.some((u) => u.includes("t.co")))]);
  checks.push([
    "FxTwitter collects tweet + quote images",
    Boolean(fx && fx.images.length >= 2),
  ]);
  checks.push([
    "quoted text is folded into the body",
    Boolean(fx?.text.includes("QT @quoted")),
  ]);

  const vx = capturedFromAny(VX);
  checks.push(["vxTwitter payload yields images and github link", Boolean(
    vx?.tweetId === "999" &&
      vx.images.includes("https://pbs.twimg.com/media/VXIMG.jpg") &&
      vx.links.includes("https://github.com/acme/ship"),
  )]);

  const row: Bookmark = {
    id: "00000000-0000-0000-0000-000000000001",
    tweetId: "1234567890",
    tweetUrl: "https://x.com/demo/status/1234567890",
    author: "demo",
    text: "New paper",
    publishedAt: new Date("2026-08-22T12:00:00Z"),
    capturedAt: new Date("2026-08-23T10:00:00Z"),
    links: ["https://arxiv.org/abs/2401.00001"],
    images: ["https://pbs.twimg.com/media/ABC123.jpg"],
    raw: { linkTitles: { "https://arxiv.org/abs/2401.00001": "A paper" } },
  };
  const ingest = bookmarkToIngestItems(row);
  const kinds = ingest.map((i) => i.raw?.kind);
  checks.push([
    "ingest emits the tweet, each link, and each image",
    kinds.includes("tweet") && kinds.includes("link") && kinds.includes("image") && ingest.length === 3,
  ]);
  checks.push([
    "link item keeps the page title from capture",
    ingest.some((i) => i.raw?.kind === "link" && i.title === "A paper"),
  ]);
  checks.push([
    "image item carries imageUrl in raw",
    ingest.some(
      (i) => i.raw?.kind === "image" && i.raw.imageUrl === "https://pbs.twimg.com/media/ABC123.jpg",
    ),
  ]);

  const noisy = Array.from({ length: 80 }, (_, i) =>
    item({ id: `c${i}`, title: `Core ${i}`, score: 900, tier: "core" }),
  );
  const saved = [
    item({ id: "s1", title: "Saved tweet", score: 1, tier: "saved", sourceSlug: "bookmarks" }),
    item({ id: "s2", title: "Saved link", score: 1, tier: "saved", sourceSlug: "bookmarks" }),
  ];
  const corpus = selectCorpus([...noisy, ...saved]);
  checks.push([
    "selectCorpus keeps saved items even when they score last",
    corpus.some((i) => i.id === "s1") && corpus.some((i) => i.id === "s2"),
  ]);
  checks.push(["selectCorpus respects the cap", corpus.length <= 60]);

  let failed = 0;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? "✓" : "✗"} ${label}`);
    if (!ok) failed++;
  }
  console.log(failed === 0 ? "\n✓ bookmarks verified\n" : `\n✗ ${failed} check(s) failed\n`);
  assert.equal(failed, 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
