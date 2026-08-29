/**
 * Continuity matcher, people-move fingerprints, and weekend detection.
 *
 *   npx tsx scripts/test-continuity.ts
 */
import {
  applyContinuity,
  dropRepeatMoves,
  isWeekendEdition,
  moveFingerprint,
  pairContinuity,
} from "../src/lib/continuity";
import { wireSynthesis } from "../src/synth/wire";
import type { DedupedItem } from "../src/ingest/run";

function item(partial: Partial<DedupedItem> & { id: string; title: string }): DedupedItem {
  return {
    url: null,
    body: null,
    author: null,
    score: 10,
    commentCount: null,
    velocity: null,
    discussionUrl: null,
    publishedAt: null,
    sourceSlug: "hackernews",
    tier: "core",
    duplicateCount: 1,
    alsoSeenIn: [],
    ...partial,
  };
}

let failed = 0;
function check(label: string, ok: boolean) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failed++;
}

// Two of today's themes must not claim the same yesterday thread.
const pairs = pairContinuity(
  [
    "Open-source models keep getting cheaper",
    "A RISC-V rebuttal reopened the ISA fight",
    "An unrelated hardware rumor",
  ],
  [
    "Open source models are getting cheaper",
    "The RISC-V argument reopened",
  ],
);
check("greedy pairing produced two links", pairs.length === 2);
check(
  "each yesterday thread is claimed once",
  new Set(pairs.map((p) => p.yesterdayIndex)).size === 2,
);

const applied = applyContinuity(
  [
    { name: "Open-source models keep getting cheaper", isNew: true as boolean },
    { name: "A new model drop from a lab nobody expected", isNew: true as boolean },
  ],
  [{ date: "2026-08-26", name: "Open source models are getting cheaper" }],
);
check("matched theme is marked ongoing even if the model said new", applied[0].isNew === false);
check("unmatched theme stays new", applied[1].isNew === true);

check(
  "fingerprint needs an org",
  moveFingerprint({ person: "Jane Researcher" }) === null,
);
check(
  "fingerprint is stable across from/to",
  moveFingerprint({ person: "Jane Researcher", toOrg: "SmallLab" }) ===
    moveFingerprint({ person: "jane researcher", fromOrg: "SmallLab" }),
);

const kept = dropRepeatMoves(
  [
    { person: "Jane Researcher", toOrg: "SmallLab", rank: 0 },
    { person: "New Person", toOrg: "OtherCo", rank: 1 },
  ],
  new Set([moveFingerprint({ person: "Jane Researcher", toOrg: "SmallLab" })!]),
);
check("repeat move is dropped", kept.length === 1 && kept[0].person === "New Person");
check("ranks are rewritten after the drop", (kept[0] as { rank: number }).rank === 0);

check("Saturday is a weekend edition", isWeekendEdition("2026-08-22") === true);
check("Monday is not", isWeekendEdition("2026-08-24") === false);

const wire = wireSynthesis(
  [
    item({
      id: "1",
      title: "Lab ships an agent runtime",
      score: 400,
      duplicateCount: 3,
      alsoSeenIn: ["techmeme", "theverge"],
    }),
    item({ id: "2", title: "A quieter RISC-V thread", score: 80 }),
  ],
  "2026-08-27",
  "no key configured",
);
check("wire provider is labeled wire, not heuristic", wire.provider === "wire");
check("wire headline is the lead item, not a token cluster", wire.headline === "Lab ships an agent runtime");
check("wire intro admits it is not editorial", /wire edition/i.test(wire.intro) && /not clustered/i.test(wire.intro));
check("wire does not invent a slash-theme name", !wire.themes.some((t) => t.name.includes(" / ")));

console.log(failed === 0 ? "\n✓ continuity verified\n" : `\n✗ ${failed} check(s) failed\n`);
process.exit(failed === 0 ? 0 : 1);
