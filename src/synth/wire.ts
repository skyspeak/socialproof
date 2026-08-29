import type { DedupedItem } from "@/ingest/run";
import { heuristicPeopleMoves, rankScore } from "./heuristic";
import type { SynthesisOutput } from "./types";

/**
 * Honest fallback when no model runs, or the model returns nothing usable.
 *
 * The old heuristic named themes after shared tokens ("deepseek / harness /
 * plugin"). That is not a newspaper; it is a word cloud wearing the issue's
 * clothes. A wire edition is a ranked list of what actually arrived, labeled
 * as a wire, so the reader is not lied to about editorial judgment.
 */
const WIRE_LENGTH = 8;

export function wireSynthesis(
  items: DedupedItem[],
  date: string,
  reason: string,
): SynthesisOutput {
  const ranked = [...items].sort((a, b) => rankScore(b) - rankScore(a));
  const lead = ranked[0];
  const wire = ranked.slice(0, WIRE_LENGTH);

  const themes = wire.map((item, rank) => {
    const desks = [item.sourceSlug, ...item.alsoSeenIn];
    const deskLine = desks.join(", ");
    const scoreBit = item.score != null ? `Score ${item.score}` : "Unscored";
    const corroboration =
      item.duplicateCount > 1
        ? `carried by ${item.duplicateCount} sources`
        : "single desk";
    return {
      name: item.title.slice(0, 200),
      summary: `${deskLine}. ${scoreBit}; ${corroboration}.`,
      soWhat: null,
      isNew: true,
      rank,
      itemIds: [item.id],
    };
  });

  return {
    headline: lead?.title ?? "Quiet day — nothing rose above the noise.",
    intro: `Wire edition for ${date}: the model did not produce an editorial issue (${reason}). What follows is the day's intake, ranked — not clustered themes. ${items.length} items collected.`,
    themes,
    peopleMoves: heuristicPeopleMoves(items),
    provider: "wire",
  };
}
