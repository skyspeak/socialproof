import type { DedupedItem } from "@/ingest/run";
import { normalizeTitle } from "@/lib/canonical";
import type { SynthesisOutput } from "./types";

const STOP = new Set([
  "show","tell","ask","new","using","use","just","like","dont","doesnt","can",
  "will","from","that","this","what","when","your","you","its","was","were",
  "has","have","had","not","but","all","one","two","get","got","make","made",
  "more","most","now","after","before","says","said","why","how","into","out",
]);

function tokens(item: DedupedItem): string[] {
  return normalizeTitle(`${item.title} ${item.body?.slice(0, 200) ?? ""}`)
    .split(" ")
    .filter((t) => t.length > 3 && !STOP.has(t));
}

/** Importance score used both for ranking and for picking the corpus. */
export function rankScore(item: DedupedItem): number {
  const base = Math.log1p(item.score ?? 0) * 10;
  const chatter = Math.log1p(item.commentCount ?? 0) * 6;
  const corroboration = (item.duplicateCount - 1) * 25;
  const velocityBoost = Math.min(item.velocity ?? 0, 100) * 0.4;
  const tierBoost =
    item.tier === "saved" ? 20 : item.tier === "people" ? 8 : 0;
  return base + chatter + corroboration + velocityBoost + tierBoost;
}

/**
 * Deterministic fallback clustering, used when no LLM key is configured or the
 * model call fails. Groups by shared salient tokens. Noticeably blunter than
 * the model path — it names themes after their dominant term rather than
 * making a claim — but it keeps the service publishing.
 */
export function heuristicSynthesis(
  items: DedupedItem[],
  date: string,
): SynthesisOutput {
  const ranked = [...items].sort((a, b) => rankScore(b) - rankScore(a));
  const pool = ranked.slice(0, 60);

  const used = new Set<number>();
  const clusters: Array<{ key: string; members: number[] }> = [];

  for (let i = 0; i < pool.length; i++) {
    if (used.has(i)) continue;
    const seed = new Set(tokens(pool[i]));
    if (seed.size === 0) continue;

    const members = [i];
    for (let j = i + 1; j < pool.length; j++) {
      if (used.has(j)) continue;
      const other = tokens(pool[j]);
      const shared = other.filter((t) => seed.has(t)).length;
      if (shared >= 2) {
        members.push(j);
        used.add(j);
      }
    }
    used.add(i);

    if (members.length >= 2) {
      const counts = new Map<string, number>();
      for (const m of members) {
        for (const t of new Set(tokens(pool[m]))) {
          counts.set(t, (counts.get(t) ?? 0) + 1);
        }
      }
      const key = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([t]) => t)
        .join(" / ");
      clusters.push({ key, members });
    }
  }

  // Ensure we always publish something: fall back to the top singletons.
  if (clusters.length === 0) {
    for (const i of pool.slice(0, 5).keys()) {
      clusters.push({ key: normalizeTitle(pool[i].title).split(" ").slice(0, 3).join(" "), members: [i] });
    }
  }

  const themes = clusters.slice(0, 6).map((c, rank) => {
    const lead = pool[c.members[0]];
    const sourceList = [
      ...new Set(c.members.map((m) => pool[m].sourceSlug)),
    ].join(", ");
    return {
      name: c.key || lead.title.slice(0, 60),
      summary: `${c.members.length} related item${c.members.length === 1 ? "" : "s"} across ${sourceList}. Lead item: ${lead.title}`,
      soWhat: null,
      isNew: true,
      rank,
      itemIds: c.members.map((m) => pool[m].id),
    };
  });

  return {
    headline: pool[0]?.title ?? "Quiet day — nothing rose above the noise.",
    intro: `Heuristic digest for ${date}: ${items.length} items collected, grouped into ${themes.length} clusters by term overlap. No language model was configured, so these are term clusters rather than editorial themes.`,
    themes,
    peopleMoves: heuristicPeopleMoves(items),
    provider: "heuristic",
  };
}

const MOVE_PATTERNS: Array<{ re: RegExp; type: string }> = [
  { re: /^(.{2,60}?)\s+(?:is\s+)?leaving\s+(.{2,60}?)(?:\s|$|,|\.)/i, type: "departure" },
  { re: /^(.{2,60}?)\s+(?:has\s+)?(?:resigned|steps?\s+down|departs?)\s*(?:from|as)?\s*(.{0,60}?)(?:\s|$|,|\.)/i, type: "departure" },
  { re: /^(.{2,60}?)\s+joins?\s+(.{2,60}?)(?:\s|$|,|\.)/i, type: "new_role" },
  { re: /^(.{2,60}?)\s+(?:is\s+)?named\s+(?:new\s+)?(.{2,60}?)(?:\s|$|,|\.)/i, type: "promoted" },
  { re: /^(.{2,60}?)\s+(?:launches|founds|starts)\s+(.{2,60}?)(?:\s|$|,|\.)/i, type: "founded" },
];

/**
 * Very conservative regex pass over people-tier headlines. Everything found
 * this way is marked `chatter` — pattern-matching a headline is not
 * confirmation, and the schema should not pretend otherwise.
 */
export function heuristicPeopleMoves(items: DedupedItem[]): SynthesisOutput["peopleMoves"] {
  const out: SynthesisOutput["peopleMoves"] = [];

  for (const item of items) {
    if (item.tier !== "people") continue;
    for (const { re, type } of MOVE_PATTERNS) {
      const m = item.title.match(re);
      if (!m) continue;
      const person = m[1]?.trim();
      if (!person || person.split(" ").length > 5) break;

      out.push({
        person,
        fromOrg: type === "departure" ? (m[2]?.trim() || null) : null,
        toOrg: type === "departure" ? null : (m[2]?.trim() || null),
        role: null,
        moveType: type,
        confidence: "chatter",
        note: "Pattern-matched from a headline; not independently confirmed.",
        evidenceUrl: item.url,
        rawItemId: item.id,
        rank: out.length,
      });
      break;
    }
  }

  return out.slice(0, 12);
}
