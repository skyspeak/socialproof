/**
 * The game-feed projection: term ranking, verbatim briefs, org extraction, and
 * the confirmed-only gate on the people beat.
 *
 *   npx tsx scripts/test-gamefeed.ts
 */
import type { DigestView, ThemeView } from "../src/db/queries";
import { buildGameFeed } from "../src/lib/gamefeed";
import { FIXTURE_DIGEST } from "../src/lib/fixture-digest";

let failed = 0;
function check(label: string, ok: boolean) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failed++;
}

function theme(partial: Partial<ThemeView> & { id: string; name: string }): ThemeView {
  return {
    summary: "",
    soWhat: null,
    isNew: true,
    desks: [],
    continuedFrom: null,
    items: [],
    ...partial,
  };
}

function digest(partial: Partial<DigestView>): DigestView {
  return {
    id: "d",
    date: "2026-09-20",
    status: "published",
    headline: null,
    intro: null,
    itemCount: 0,
    generatedAt: null,
    windowStart: new Date(),
    windowEnd: new Date(),
    provider: "gemini",
    edition: "editorial",
    prevDate: null,
    nextDate: null,
    themes: [],
    people: [],
    bookmarks: [],
    sourceHealth: [],
    ...partial,
  };
}

// ---- terms ----------------------------------------------------------------

const feed = buildGameFeed(FIXTURE_DIGEST);
const byTerm = new Map(feed.terms.map((t) => [t.term, t]));

check("fixture yields five-letter terms", feed.terms.length > 0);
check(
  "every term is exactly five letters",
  feed.terms.every((t) => /^[a-z]{5}$/.test(t.term)),
);
check(
  "every returned term carries a quotable brief",
  feed.terms.every((t) => t.brief !== null),
);
check("terms are ranked descending", feed.terms.every((t, i, a) => i === 0 || a[i - 1].weight >= t.weight));
check("function words are filtered", !byTerm.has("their") && !byTerm.has("would"));
check("retrieved date is the digest date", feed.terms.every((t) => t.brief!.retrieved === FIXTURE_DIGEST.date));

// The brief is a copy, not a summary. Find the row it claims to quote.
const allTitles = new Set(FIXTURE_DIGEST.themes.flatMap((t) => t.items.map((i) => i.title)));
check(
  "every brief headline is verbatim a row title",
  feed.terms.every((t) => allTitles.has(t.brief!.headline)),
);
// Punctuation is normalized away on extraction, so `RISC-V` yields `riscv`.
// The guarantee is that the quote contains the term, not the exact substring.
const bare = (s: string) => (s.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).map((w) => w.toLowerCase().replace(/[^a-z]/g, ""));
check(
  "a term's brief actually contains the term",
  feed.terms.every((t) => bare(t.brief!.headline).includes(t.term)),
);

// A term riding the lead theme outranks the same exposure further down.
const tapered = buildGameFeed(
  digest({
    themes: [
      theme({
        id: "a",
        name: "alpha alpha",
        items: [{ id: "1", title: "A story about alpha", url: "https://a", discussionUrl: null, sourceName: "HN", score: null, commentCount: null, imageUrl: null }],
      }),
      theme({
        id: "b",
        name: "bravo bravo",
        items: [{ id: "2", title: "A story about bravo", url: "https://b", discussionUrl: null, sourceName: "HN", score: null, commentCount: null, imageUrl: null }],
      }),
    ],
  }),
);
check("theme rank tapers weight", tapered.terms[0].term === "alpha");

// Corroboration beats repetition.
const one = (name: string, items: ThemeView["items"]) => digest({ themes: [theme({ id: "t", name, items })] });
const mk = (id: string, title: string, sourceName: string) => ({
  id, title, url: `https://x/${id}`, discussionUrl: null, sourceName,
  score: null, commentCount: null, imageUrl: null,
});
const spread = buildGameFeed(one("x", [mk("1", "the quart story", "HN"), mk("2", "the quart story again", "Techmeme")]));
const stacked = buildGameFeed(one("x", [mk("1", "the pivot story", "HN"), mk("2", "the pivot story again", "HN")]));
check(
  "a term on two desks outweighs the same exposure on one",
  spread.terms.find((t) => t.term === "quart")!.weight >
    stacked.terms.find((t) => t.term === "pivot")!.weight,
);

// A term with no linkable item is unusable, however loud.
const unlinkable = buildGameFeed(
  digest({
    headline: "the vexed question",
    themes: [theme({ id: "t", name: "the vexed question", items: [
      { id: "1", title: "vexed again", url: null, discussionUrl: null, sourceName: "HN", score: null, commentCount: null, imageUrl: null },
    ] })],
  }),
);
check("a term with no linkable item is dropped", !unlinkable.terms.some((t) => t.term === "vexed"));

// ---- people beat ----------------------------------------------------------

const person = (over: Partial<DigestView["people"][number]>) => ({
  id: "p", person: "Ada Lovelace", fromOrg: "OldCo", toOrg: "NewCo", role: "CTO",
  moveType: "new_role", confidence: "confirmed", note: null, evidenceUrl: "https://e",
  ...over,
});

const graded = buildGameFeed(
  digest({
    people: [
      person({ id: "1", person: "Confirmed Person", confidence: "confirmed" }),
      person({ id: "2", person: "Reported Person", confidence: "reported" }),
      person({ id: "3", person: "Chatter Person", confidence: "chatter" }),
      person({ id: "4", person: "Orgless Person", confidence: "confirmed", fromOrg: null, toOrg: null }),
    ],
  }),
);
check("only confirmed moves survive", graded.moves.length === 1);
check("the survivor is the confirmed one", graded.moves[0]?.person === "Confirmed Person");
check("a move with no org on either side is dropped", !graded.moves.some((m) => m.person === "Orgless Person"));
check("counts report what was filtered out", graded.counts.movesInIssue === 4);

// ---- orgs -----------------------------------------------------------------

const orgs = buildGameFeed(
  digest({
    people: [person({ id: "1", fromOrg: "OpenAI", toOrg: "Anthropic" })],
    // Nvidia in two DIFFERENT headlines: recurrence means distinct stories, not
    // the same story arriving twice or one headline naming it twice.
    themes: [theme({ id: "t", name: "x", items: [
      mk("1", "Sources: Nvidia ships a chip", "Techmeme"),
      mk("2", "Analysts read Nvidia margins as a warning", "The Register"),
      mk("3", "Show HN: Kagi Search gets faster", "HN"),
    ] })],
  }),
);
const orgNames = orgs.orgs.map((o) => o.name);
check("beat orgs are kept", orgNames.includes("OpenAI") && orgNames.includes("Anthropic"));
check("beat orgs sort first", orgs.orgs[0].fromBeat && orgs.orgs[1].fromBeat);

// A wire day's heuristic moves are always graded chatter (see wire.ts) and are
// correctly filtered out of `moves` below — but `extractOrgs` used to read
// `digest.people` without that same filter, so a chatter-graded org still came
// out tagged `fromBeat: true`. Found live: a wire-edition deploy reported 27
// "editor-named" orgs with zero confirmed moves behind any of them.
const chatterOrgs = buildGameFeed(
  digest({
    people: [person({ id: "1", fromOrg: "SomeStartup", toOrg: "AnotherCo", confidence: "chatter" })],
  }),
);
check(
  "an unconfirmed move's orgs are not tagged fromBeat",
  !chatterOrgs.orgs.some((o) => o.name === "SomeStartup" || o.name === "AnotherCo"),
);
check("a name in two different headlines is picked up", orgNames.includes("Nvidia"));
// The same story from several desks is one sighting, not several.
const echoed = buildGameFeed(
  digest({ themes: [theme({ id: "t", name: "x", items: [
    mk("1", "Sources: Acme Systems raises a round", "Techmeme"),
    mk("2", "Sources: Acme Systems raises a round", "Hacker News"),
    mk("3", "Sources: Acme Systems raises a round", "Lobsters"),
  ] })] }),
);
check(
  "one headline echoed across desks is not a recurring name",
  !echoed.orgs.some((o) => o.name === "Acme Systems"),
);
check("a Show HN prefix is not mistaken for a name", !orgNames.includes("Show") && !orgNames.includes("HN"));
// A phrase seen once is a fragment of one headline, not a name. Measured on a
// live wire edition, allowing single multi-word hits produced "Spain Orders
// Blocks" and "Resident Evil" as organizations.
check("a single-mention parsed phrase is rejected", !orgNames.includes("Kagi Search"));
const junk = buildGameFeed(
  digest({
    themes: [theme({ id: "t", name: "x", items: [
      mk("1", "Spain Orders Blocks on Archive.today and Its Mirrors", "HN"),
      mk("2", "Resident Evil 4 decompilation reaches byte parity", "Lobsters"),
    ] })],
  }),
);
check("headline fragments do not become organizations", junk.orgs.length === 0);
check("a recurring parsed name still survives", orgNames.includes("Nvidia"));
check(
  "a sentence-initial word is not an org",
  !buildGameFeed(one("x", [mk("1", "Stripe ships a thing", "HN")])).orgs.some((o) => o.name === "Stripe"),
);

// ---- intake widening ------------------------------------------------------

// A wire edition is eight single-item entries, so without the day's wider
// ingest the vocabulary collapses on exactly the days no editor narrowed it.
const wireThemes = [theme({ id: "w", name: "A lab ships a runtime", items: [mk("1", "A lab ships a runtime", "HN")] })];
const narrow = buildGameFeed(digest({ edition: "wire", themes: wireThemes }));
const widened = buildGameFeed(digest({ edition: "wire", themes: wireThemes }), [
  mk("2", "A paper about vector quantization", "arXiv"),
  mk("3", "Someone rewrote the kernel scheduler", "Lobsters"),
]);
check("intake widens the term pool", widened.terms.length > narrow.terms.length);
check(
  "an editorially placed term still outranks an intake one",
  widened.terms[0].weight > widened.terms[widened.terms.length - 1].weight &&
    widened.terms[0].why !== null,
);

// An item the issue already cites must not be counted twice.
const doubled = buildGameFeed(
  digest({ themes: [theme({ id: "t", name: "x", items: [mk("1", "the quirk story", "HN")] })] }),
  [mk("1", "the quirk story", "HN")],
);
const once = buildGameFeed(
  digest({ themes: [theme({ id: "t", name: "x", items: [mk("1", "the quirk story", "HN")] })] }),
);
check(
  "an item the issue cites is not double-counted from intake",
  doubled.terms.find((t) => t.term === "quirk")!.weight ===
    once.terms.find((t) => t.term === "quirk")!.weight,
);

// ---- wire day -------------------------------------------------------------

const wire = buildGameFeed(
  digest({
    edition: "wire",
    provider: "wire",
    themes: [theme({ id: "t", name: "A lab ships an agent runtime", items: [mk("1", "A lab ships an agent runtime", "HN")] })],
    people: [person({ id: "1", confidence: "chatter" })],
  }),
);
check("a wire day still yields terms", wire.terms.length > 0);
check("a wire day yields no moves", wire.moves.length === 0);
check("the wire edition is labeled", wire.edition === "wire");

console.log(failed === 0 ? "\n✓ game feed verified\n" : `\n✗ ${failed} check(s) failed\n`);
process.exit(failed === 0 ? 0 : 1);
