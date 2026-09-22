import type { DigestItemView, DigestView } from "@/db/queries";

/**
 * The narrow projection of an issue that downstream games build against.
 *
 * `DigestView` is the *reading* shape — nested themes, their items, bookmarks
 * and source health. A game wants something flat, ranked and pre-filtered, and
 * it wants the filtering that makes the data safe to assert to live in exactly
 * one place rather than duplicated in every consumer. That is this module.
 *
 * Three rules are enforced here and nowhere else:
 *   1. A term is only usable if some item can be quoted verbatim as its brief.
 *   2. A move is only usable when the editor graded it `confirmed` — a quiz
 *      asserts, and `reported` / `chatter` are not assertions we can make.
 *   3. Nothing in the output is generated prose. Every string is copied from a
 *      row, which is what keeps a downstream game from inventing the news.
 */

export type GameBrief = {
  /** Verbatim `raw_items.title`. Never paraphrased, never summarized. */
  headline: string;
  source: string;
  url: string;
  /** The digest date, so a consumer can say when this was retrieved. */
  retrieved: string;
};

export type GameTerm = {
  term: string;
  weight: number;
  /** Distinct desks the term appeared on — the corroboration signal. */
  desks: number;
  /** The theme that contributed most of the weight, for context. */
  why: string | null;
  brief: GameBrief | null;
};

export type GameOrg = {
  name: string;
  mentions: number;
  url: string | null;
  /** True when the name came from the people beat rather than title parsing. */
  fromBeat: boolean;
};

export type GameMove = {
  person: string;
  fromOrg: string | null;
  toOrg: string | null;
  role: string | null;
  moveType: string;
  note: string | null;
  evidenceUrl: string | null;
};

export type GameFeed = {
  date: string;
  edition: "editorial" | "wire";
  headline: string | null;
  terms: GameTerm[];
  orgs: GameOrg[];
  moves: GameMove[];
  counts: {
    themes: number;
    items: number;
    /** Moves in the issue before the confirmed-only filter. */
    movesInIssue: number;
  };
};

/**
 * Five-letter function words and headline filler. Deliberately shorter than the
 * equivalent list in a consumer: the consumer's own clue file is the real
 * quality gate, so over-filtering here only hides candidates it could have used.
 */
const STOPWORDS = new Set(
  `about above after again among being below could doing early every first
   again great group heres inside isnt into just large later least might month
   never other ought right shall since small start still their there these
   third those three today under until using wants weeks where which while
   whose worth would years yours thats whats wasnt arent youre theyre cant
   dont wont didnt hasnt havent`
    .split(/\s+/)
    .filter(Boolean),
);

/** Capitalized tokens that start headlines or name no organization. */
const COMMON_CAPS = new Set(
  `The A An And But For Nor Or So Yet This That These Those New Now Why How
   What When Where Who Whom Which While After Before Inside Introducing
   Announcing Building Show Ask Tell Launch Launching Sources Report Exclusive
   Opinion Analysis Review First Last Next Best Top Here There It Its We Our
   You Your My I If Is Are Was Were Has Have Had Will Can Could Should Would
   Do Does Did Not No Yes One Two Three AI ML API APIs LLM LLMs GPU GPUs CPU
   CPUs CEO CTO CFO COO US USA UK EU UN PDF RFC URL HTTP HTTPS OK IPO VC SDK
   CLI GUI OS RAM SSD IoT AR VR`
    .split(/\s+/)
    .filter(Boolean),
);

/** HN and aggregator prefixes that are not part of the headline's substance. */
const TITLE_PREFIX = /^(?:show|ask|tell)\s+hn:\s*/i;

function words(text: string): string[] {
  return text.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
}

function fiveLetter(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of words(text)) {
    const k = w.toLowerCase().replace(/[^a-z]/g, "");
    if (k.length === 5 && !STOPWORDS.has(k)) out.add(k);
  }
  return out;
}

type Accum = {
  weight: number;
  desks: Set<string>;
  why: string | null;
  whyWeight: number;
  brief: GameBrief | null;
  briefWeight: number;
};

function accum(): Accum {
  return {
    weight: 0,
    desks: new Set(),
    why: null,
    whyWeight: 0,
    brief: null,
    briefWeight: 0,
  };
}

/**
 * Themes arrive ranked most to least important. A term riding the lead theme is
 * more topical than the same term at the bottom of the issue, but the taper is
 * gentle — rank 6 is still the day's news, not noise.
 */
function rankFactor(rank: number): number {
  return 1 / (1 + rank * 0.15);
}

/**
 * @param intake the day's wider ingest, beyond the items the issue cites.
 *   Contributes at a low weight so editorial placement still dominates the
 *   ranking, but stops a wire edition — eight single-item entries — from
 *   collapsing the vocabulary a consumer has to work with.
 */
export function buildGameFeed(
  digest: DigestView,
  intake: DigestItemView[] = [],
): GameFeed {
  const terms = new Map<string, Accum>();

  const add = (
    text: string | null,
    weight: number,
    opts: { desk?: string; why?: string; brief?: GameBrief } = {},
  ) => {
    if (!text) return;
    for (const term of fiveLetter(text)) {
      const a = terms.get(term) ?? accum();
      a.weight += weight;
      if (opts.desk) a.desks.add(opts.desk);
      if (opts.why && weight > a.whyWeight) {
        a.why = opts.why;
        a.whyWeight = weight;
      }
      // A term's brief is the best-placed item whose *title* contains it, so
      // the quote a consumer prints always actually says the word.
      if (opts.brief && weight > a.briefWeight) {
        a.brief = opts.brief;
        a.briefWeight = weight;
      }
      terms.set(term, a);
    }
  };

  add(digest.headline, 6);

  let itemCount = 0;
  for (const [rank, theme] of digest.themes.entries()) {
    const f = rankFactor(rank);
    add(theme.name, 4 * f, { why: theme.name });
    add(theme.soWhat, 2.5 * f, { why: theme.name });
    add(theme.summary, 1 * f, { why: theme.name });
    for (const item of theme.items) {
      itemCount += 1;
      const title = item.title.replace(TITLE_PREFIX, "");
      add(title, 2 * f, {
        desk: item.sourceName,
        why: theme.name,
        brief: item.url
          ? {
              headline: item.title,
              source: item.sourceName,
              url: item.url,
              retrieved: digest.date,
            }
          : undefined,
      });
    }
  }

  // Below every theme item, so an editorially placed term always outranks one
  // that merely arrived. Deduplicated against what the issue already cited.
  const cited = new Set(
    digest.themes.flatMap((t) => t.items.map((i) => i.id)),
  );
  for (const item of intake) {
    if (cited.has(item.id)) continue;
    const title = item.title.replace(TITLE_PREFIX, "");
    add(title, 0.6, {
      desk: item.sourceName,
      brief: item.url
        ? {
            headline: item.title,
            source: item.sourceName,
            url: item.url,
            retrieved: digest.date,
          }
        : undefined,
    });
  }

  const rankedTerms: GameTerm[] = [...terms]
    // Corroboration is worth more than repetition: a term carried by three
    // desks beats one said three times in the same place.
    .map(([term, a]) => ({
      term,
      weight:
        Math.round(a.weight * (1 + 0.35 * Math.max(0, a.desks.size - 1)) * 100) /
        100,
      desks: a.desks.size,
      why: a.why,
      brief: a.brief,
    }))
    // Without a quotable item there is nothing to show a player, so the term is
    // not usable however often it appeared.
    .filter((t) => t.brief !== null)
    .sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term));

  return {
    date: digest.date,
    edition: digest.edition,
    headline: digest.headline,
    terms: rankedTerms,
    orgs: extractOrgs(digest, intake),
    // Heuristic moves on a wire day are graded `chatter` by design, so this
    // filter empties the beat exactly when there was no editor to vouch for it.
    moves: digest.people
      .filter((p) => p.confidence === "confirmed")
      .filter((p) => p.person && (p.fromOrg || p.toOrg))
      .map((p) => ({
        person: p.person,
        fromOrg: p.fromOrg,
        toOrg: p.toOrg,
        role: p.role,
        moveType: p.moveType,
        note: p.note,
        evidenceUrl: p.evidenceUrl,
      })),
    counts: {
      themes: digest.themes.length,
      items: itemCount,
      movesInIssue: digest.people.length,
    },
  };
}

/**
 * Organization names in the issue.
 *
 * Two sources with different reliability. The people beat names orgs because a
 * model was asked to, so those are taken as given. Title parsing is a heuristic
 * — capitalized runs, skipping the first token because sentence-initial caps
 * say nothing — and is marked as such so a consumer can weight it lower.
 */
function extractOrgs(digest: DigestView, intake: DigestItemView[]): GameOrg[] {
  type Seen = {
    name: string;
    /** Distinct headlines, not raw sightings — see below. */
    titles: Set<string>;
    url: string | null;
    beat: boolean;
  };
  const found = new Map<string, Seen>();

  /**
   * `where` identifies the headline a sighting came from.
   *
   * Counting raw sightings does not work: the same story arrives from several
   * sources, so one headline repeated across desks looked like a name that
   * recurred across the day. Measured live, that promoted "Ban Private Equity"
   * and "Owning Medical Practices" to nine mentions each off a single story.
   * Distinct headlines is the count that means what the filter below assumes.
   */
  const bump = (raw: string, url: string | null, beat: boolean, where: string) => {
    const name = raw.replace(/[.,;:'"]+$/, "").trim();
    if (name.length < 2 || name.length > 60) return;
    const key = name.toLowerCase();
    const prev = found.get(key);
    if (!prev) {
      found.set(key, { name, titles: new Set([where]), url, beat });
      return;
    }
    prev.titles.add(where);
    prev.url ??= url;
    prev.beat ||= beat;
  };

  // `fromBeat: true` is a downstream consumer's signal to trust a name without
  // corroboration — front-door uses it to badge a company "in the news" off a
  // single mention. `digest.people` carries every confidence tier, including
  // the wire fallback's heuristic guesses (always graded chatter). Gating this
  // the same way the `moves` array below is gated is what keeps "confirmed"
  // meaning the same thing everywhere in this file: a wire day has no editor,
  // so it must produce no beat-trusted orgs either, not merely no moves.
  for (const p of digest.people) {
    if (p.confidence !== "confirmed") continue;
    const where = `beat:${p.person}`;
    if (p.fromOrg) bump(p.fromOrg, p.evidenceUrl, true, where);
    if (p.toOrg) bump(p.toOrg, p.evidenceUrl, true, where);
  }

  const titles = [
    ...digest.themes.flatMap((t) => t.items.map((i) => ({ t: i.title, u: i.url }))),
    ...intake.map((i) => ({ t: i.title, u: i.url })),
  ];
  for (const { t, u } of titles) {
    const clean = t.replace(TITLE_PREFIX, "");
    const where = clean.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    for (const phrase of capitalizedRuns(clean)) bump(phrase, u, false, where);
  }

  return [...found.values()]
    .map((o) => ({
      name: o.name,
      mentions: o.titles.size,
      url: o.url,
      fromBeat: o.beat,
    }))
    // A name from the beat is kept at any count — an editor put it there. A
    // parsed one has to RECUR, multi-word or not. Allowing a single multi-word
    // hit let "Spain Orders Blocks" and "Resident Evil" through as
    // organizations on a live wire day; a phrase that appears once is a
    // fragment of one headline, not a name the day was about. Emitting nothing
    // is better than emitting that, because a consumer matching against its own
    // dataset cannot tell the difference.
    .filter((o) => o.fromBeat || o.mentions > 1)
    .sort(
      (a, b) =>
        Number(b.fromBeat) - Number(a.fromBeat) ||
        b.mentions - a.mentions ||
        a.name.localeCompare(b.name),
    );
}

/**
 * Runs of up to three capitalized tokens.
 *
 * A run that starts the headline needs at least two tokens to count. English
 * capitalizes the first word whatever it is, so `Stripe ships a thing` cannot
 * distinguish a name from a verb — but `Kagi Search gets faster` can, because
 * the second capital is not explained by position. Dropping token 0 outright
 * was worse: it split real names whenever an aggregator prefix had been
 * stripped off the front.
 */
function capitalizedRuns(title: string): string[] {
  const toks = title.split(/\s+/);
  const out: string[] = [];
  let run: string[] = [];
  let runStart = -1;

  const flush = () => {
    if (run.length >= 2 || (run.length === 1 && runStart > 0)) {
      out.push(run.join(" "));
    }
    run = [];
    runStart = -1;
  };

  for (const [i, tok] of toks.entries()) {
    const bare = tok.replace(/^[^A-Za-z0-9]+/, "").replace(/[^A-Za-z0-9&.+-]+$/, "");
    if (!/^[A-Z][A-Za-z0-9&.+-]*$/.test(bare) || COMMON_CAPS.has(bare) || bare.length < 2) {
      flush();
      continue;
    }
    if (!run.length) runStart = i;
    run.push(bare);
    if (run.length === 3) flush();
  }
  flush();
  return out;
}
