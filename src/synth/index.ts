import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { digests, peopleMoves, themeItems, themes } from "@/db/schema";
import type { DedupedItem } from "@/ingest/run";
import type { Window } from "@/lib/window";
import { heuristicSynthesis, rankScore } from "./heuristic";
import { completeJson, hasLlm, parseJsonLoose } from "./llm";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompt";
import {
  CONFIDENCE_LEVELS,
  MOVE_TYPES,
  type ModelOutput,
  type SynthesisOutput,
} from "./types";

/**
 * Corpus cap, tuned by measurement rather than guesswork.
 *
 * At 120 items (~50k prompt chars) with an 8k output budget, a live Sonnet call
 * did not return within 10 minutes — which on Vercel means the function is
 * killed at its 300s ceiling and the day publishes nothing. At 60 items
 * (~17-22k chars) the same call returns in ~40s with better-focused themes,
 * because the model isn't diluting attention across a long tail of low-signal
 * items. Dedup and rank ordering mean the top 60 already carry the day.
 */
const MAX_CORPUS = Number(process.env.SYNTH_MAX_CORPUS ?? 60);

/** Output token budget for the synthesis call. */
const MAX_OUTPUT_TOKENS = Number(process.env.SYNTH_MAX_TOKENS ?? 5000);

export function selectCorpus(items: DedupedItem[]): DedupedItem[] {
  const ranked = [...items].sort((a, b) => rankScore(b) - rankScore(a));

  // Guarantee the people tier gets representation even if it scores low —
  // otherwise a busy AI news day would crowd the people beat out entirely.
  const people = ranked.filter((i) => i.tier === "people").slice(0, 15);
  const rest = ranked.filter((i) => i.tier !== "people");

  const merged = [...people];
  for (const item of rest) {
    if (merged.length >= MAX_CORPUS) break;
    merged.push(item);
  }
  return merged;
}

function mapModelOutput(
  model: ModelOutput,
  corpus: DedupedItem[],
  provider: string,
): SynthesisOutput {
  const at = (i: number | null | undefined) =>
    i == null || i < 0 || i >= corpus.length ? null : corpus[i];

  const mappedThemes = (model.themes ?? [])
    .filter((t) => t?.name && t?.summary)
    .slice(0, 8)
    .map((t, rank) => ({
      name: String(t.name).slice(0, 200),
      summary: String(t.summary),
      soWhat: t.soWhat ? String(t.soWhat) : null,
      isNew: t.isNew !== false,
      rank,
      itemIds: (t.itemIndexes ?? [])
        .map((i) => at(i)?.id)
        .filter((id): id is string => Boolean(id)),
    }));

  const mappedMoves = (model.peopleMoves ?? [])
    .filter((m) => m?.person && String(m.person).trim().length > 1)
    .slice(0, 15)
    .map((m, rank) => {
      const item = at(m.itemIndex);
      const moveType = MOVE_TYPES.has(String(m.moveType)) ? String(m.moveType) : "other";
      const confidence = CONFIDENCE_LEVELS.has(String(m.confidence))
        ? String(m.confidence)
        : "reported";
      return {
        person: String(m.person).slice(0, 200),
        fromOrg: m.fromOrg ? String(m.fromOrg) : null,
        toOrg: m.toOrg ? String(m.toOrg) : null,
        role: m.role ? String(m.role) : null,
        moveType,
        confidence,
        note: m.note ? String(m.note) : null,
        evidenceUrl: item?.url ?? null,
        rawItemId: item?.id ?? null,
        rank,
      };
    });

  return {
    headline: model.headline ? String(model.headline) : "No single story dominated.",
    intro: model.intro ? String(model.intro) : "",
    themes: mappedThemes,
    peopleMoves: mappedMoves,
    provider,
  };
}

export async function synthesize(
  items: DedupedItem[],
  window: Window,
): Promise<SynthesisOutput> {
  if (items.length === 0) {
    return {
      headline: "No items collected.",
      intro:
        "Every source returned empty for this window. Check the run log — this usually means a deploy issue rather than a quiet day.",
      themes: [],
      peopleMoves: [],
      provider: "none",
    };
  }

  const corpus = selectCorpus(items);

  if (!hasLlm()) {
    return heuristicSynthesis(items, window.date);
  }

  try {
    const { text, provider } = await completeJson(
      SYSTEM_PROMPT,
      buildUserPrompt({ date: window.date, items: corpus }),
      MAX_OUTPUT_TOKENS,
    );
    const parsed = parseJsonLoose<ModelOutput>(text);
    const mapped = mapModelOutput(parsed, corpus, provider);
    // A model that returns no usable themes is a failure, not a quiet day.
    if (mapped.themes.length === 0) throw new Error("model returned no themes");
    return mapped;
  } catch (err) {
    const fallback = heuristicSynthesis(items, window.date);
    fallback.intro = `${fallback.intro} (Model synthesis failed: ${
      err instanceof Error ? err.message : String(err)
    })`;
    return fallback;
  }
}

/** Replace any prior synthesis for this digest and mark it published. */
export async function persistSynthesis(
  digestId: string,
  output: SynthesisOutput,
  itemCount: number,
): Promise<void> {
  const db = await getDb();

  await db.delete(themes).where(eq(themes.digestId, digestId));
  await db.delete(peopleMoves).where(eq(peopleMoves.digestId, digestId));

  for (const t of output.themes) {
    const [row] = await db
      .insert(themes)
      .values({
        digestId,
        name: t.name,
        summary: t.summary,
        soWhat: t.soWhat,
        isNew: t.isNew,
        rank: t.rank,
      })
      .returning({ id: themes.id });

    if (t.itemIds.length) {
      await db
        .insert(themeItems)
        .values(
          t.itemIds.map((rawItemId, rank) => ({
            themeId: row.id,
            rawItemId,
            rank,
          })),
        )
        .onConflictDoNothing();
    }
  }

  if (output.peopleMoves.length) {
    await db.insert(peopleMoves).values(
      output.peopleMoves.map((m) => ({
        digestId,
        person: m.person,
        fromOrg: m.fromOrg,
        toOrg: m.toOrg,
        role: m.role,
        moveType: m.moveType,
        confidence: m.confidence,
        note: m.note,
        evidenceUrl: m.evidenceUrl,
        rawItemId: m.rawItemId,
        rank: m.rank,
      })),
    );
  }

  await db
    .update(digests)
    .set({
      status: "published",
      headline: output.headline,
      intro: output.intro,
      itemCount,
      generatedAt: new Date(),
    })
    .where(eq(digests.id, digestId));
}
