import type { DedupedItem } from "@/ingest/run";

export const SYSTEM_PROMPT = `You are the editor of a daily technology digest read by a technically sophisticated audience — engineers, founders, researchers. Your reader has deliberately stopped reading X and relies on you to tell them what the industry actually spent the day arguing about.

Your standards:
- Cluster into THEMES, not a list of links. A theme is a claim about what is happening, not a topic label. "Everyone is rediscovering that RAG is a retrieval problem" beats "AI news".
- Corroboration matters. An item carried by several independent sources is more important than one loud post.
- Be honest about a quiet day. Four real themes beat seven padded ones. Never invent significance.
- The "so what" is the product. Anyone can summarize a headline; say why a reader should care or what it implies.
- For people moves, distinguish what is CONFIRMED (the person or company said it), REPORTED (credible outlet, unconfirmed by principals), and CHATTER (circulating, unverified). Never upgrade a rumor. If you cannot identify a real named person moving between real named organizations, return no people moves rather than manufacturing them.
- Prose is plain and direct. No hype, no "in today's fast-moving landscape", no exclamation marks.`;

export type SynthesisRequest = {
  date: string;
  items: DedupedItem[];
  previousThemes?: string[];
};

export function buildUserPrompt({ date, items, previousThemes }: SynthesisRequest): string {
  const lines = items.map((it, i) => {
    const bits = [
      `[${i}] ${it.title}`,
      `    source: ${it.sourceSlug}${it.alsoSeenIn.length ? ` (+${it.alsoSeenIn.join(", ")})` : ""}`,
    ];
    if (it.score != null) {
      bits.push(
        `    score: ${it.score}${it.commentCount != null ? `, comments: ${it.commentCount}` : ""}`,
      );
    }
    if (it.url) bits.push(`    url: ${it.url}`);
    if (it.body) bits.push(`    excerpt: ${it.body.slice(0, 400)}`);
    return bits.join("\n");
  });

  const yesterday =
    previousThemes && previousThemes.length
      ? `Yesterday's published themes — mark isNew false when today's theme is the same story, even if the wording changed:\n${previousThemes.map((n) => `- ${n}`).join("\n")}\n\n`
      : "";

  return `Digest date: ${date}
Items collected in the last 24 hours: ${items.length}

${yesterday}Return ONLY a JSON object with this exact shape:

{
  "headline": "one sentence: the single most important thing that happened",
  "intro": "one short paragraph (2-4 sentences) giving the shape of the day",
  "themes": [
    {
      "name": "short, specific, claim-like",
      "summary": "2-4 sentences on what happened, synthesized across sources",
      "soWhat": "one sentence on why it matters or what it implies",
      "isNew": true,
      "itemIndexes": [0, 4, 9]
    }
  ],
  "peopleMoves": [
    {
      "person": "Full Name",
      "fromOrg": "org or null",
      "toOrg": "org or null",
      "role": "the role, or null",
      "moveType": "departure | new_role | founded | promoted | board | funding | layoff | other",
      "confidence": "confirmed | reported | chatter",
      "note": "one line on why this signals something",
      "itemIndex": 12
    }
  ]
}

Rules:
- 4 to 7 themes, ordered most to least important. Fewer if the day was genuinely quiet.
- "itemIndexes" must reference the numbered items below; include 2-6 per theme where available.
- "isNew" is false when yesterday already published this story. Prefer that list over a hunch.
- peopleMoves may be an empty array. Only include a move if the source material names a real person. Do not infer moves from speculation.

ITEMS:
${lines.join("\n")}`;
}
