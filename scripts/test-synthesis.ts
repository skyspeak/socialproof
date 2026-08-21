/**
 * Verifies the model synthesis path without a live provider.
 *
 * Stands up a stub OpenAI-compatible server, points the client at it, and runs
 * the real synthesize() → persistSynthesis() → getDigest() chain. This exercises
 * everything the production path does except the provider's own network hop:
 * prompt assembly, JSON recovery, index→row-id mapping, validation of enum
 * fields, persistence, and read-back.
 *
 *   npx tsx scripts/test-synthesis.ts
 */
import { createServer } from "node:http";
import assert from "node:assert";

process.env.DATABASE_URL ??= "pglite://./.pglite-test";

const MODEL_REPLY = {
  headline: "Two labs shipped agent frameworks on the same afternoon",
  intro: "A quiet Sunday broke open when both releases landed within an hour.",
  themes: [
    {
      name: "Agent frameworks converge on plugin architectures",
      summary: "Two independent releases adopted near-identical plugin models.",
      soWhat: "Convergence this fast usually means the abstraction is correct.",
      isNew: true,
      itemIndexes: [0, 1],
    },
    {
      name: "The RISC-V argument reopened",
      summary: "An embedded engineer's rebuttal drew sustained discussion.",
      soWhat: "The ISA debate is really a toolchain-maturity debate.",
      isNew: false,
      itemIndexes: [1],
    },
  ],
  peopleMoves: [
    {
      person: "Jane Researcher",
      fromOrg: "BigLab",
      toOrg: "SmallLab",
      role: "Head of Alignment",
      moveType: "new_role",
      confidence: "confirmed",
      note: "Second senior departure from BigLab this month.",
      itemIndex: 0,
    },
    {
      person: "Bogus Entry",
      moveType: "not_a_real_type",
      confidence: "totally_sure",
      itemIndex: 999,
    },
  ],
};

async function main() {
  // ---- stub provider -------------------------------------------------------
  let sawSystemPrompt = false;
  let sawItems = false;

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const system = parsed.messages.find((m: any) => m.role === "system");
      const user = parsed.messages.find((m: any) => m.role === "user");
      sawSystemPrompt = /editor of a daily technology digest/.test(system.content);
      sawItems = /ITEMS:/.test(user.content);

      res.writeHead(200, { "content-type": "application/json" });
      // Wrap in a fence to also exercise the loose JSON recovery path.
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "```json\n" + JSON.stringify(MODEL_REPLY) + "\n```",
              },
            },
          ],
        }),
      );
    });
  });

  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;

  delete process.env.ANTHROPIC_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}`;

  // ---- fixture DB ----------------------------------------------------------
  const { PGlite } = await import("@electric-sql/pglite");
  const { readFileSync, readdirSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");

  const dir = process.env.DATABASE_URL!.slice("pglite://".length);
  rmSync(dir, { recursive: true, force: true });

  const client = new PGlite(dir);
  await client.waitReady;
  for (const f of readdirSync("drizzle").filter((f) => f.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join("drizzle", f), "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean)) {
      await client.exec(stmt);
    }
  }
  await client.close();

  const { getDb } = await import("../src/db");
  const { sources, rawItems, digests } = await import("../src/db/schema");
  const { windowFor } = await import("../src/lib/window");
  const { synthesize, persistSynthesis } = await import("../src/synth");
  const { getDigest } = await import("../src/db/queries");
  const { loadWindowItems } = await import("../src/ingest/run");

  const db = await getDb();
  const window = windowFor(new Date());

  const [src] = await db
    .insert(sources)
    .values({ slug: "fixture", name: "Fixture", kind: "test", tier: "core" })
    .returning();

  await db.insert(rawItems).values([
    {
      sourceId: src.id,
      externalId: "a",
      title: "LabOne ships an agent framework built entirely on plugins",
      canonicalUrl: "https://example.com/a",
      contentHash: "hash-a",
      url: "https://example.com/a",
      score: 420,
      publishedAt: new Date(),
    },
    {
      sourceId: src.id,
      externalId: "b",
      title: "A 3rd World Embedded Engineer Responds to RISC-V criticism",
      canonicalUrl: "https://example.com/b",
      contentHash: "hash-b",
      url: "https://example.com/b",
      score: 310,
      publishedAt: new Date(),
    },
  ]);

  const [digest] = await db
    .insert(digests)
    .values({
      digestDate: window.date,
      status: "synthesizing",
      windowStart: window.start,
      windowEnd: window.end,
    })
    .returning();

  // ---- exercise the real path ---------------------------------------------
  const items = await loadWindowItems(window);
  assert.equal(items.length, 2, "fixture items should load");

  const output = await synthesize(items, window);
  await persistSynthesis(digest.id, output, items.length);
  const view = await getDigest(window.date);

  server.close();

  // ---- assertions ----------------------------------------------------------
  const checks: Array<[string, boolean]> = [
    ["prompt carried the editorial system prompt", sawSystemPrompt],
    ["prompt carried the item corpus", sawItems],
    ["provider was the model, not the fallback", output.provider === "openai"],
    ["fenced JSON was recovered", output.themes.length === 2],
    [
      "headline persisted",
      view?.headline === MODEL_REPLY.headline,
    ],
    [
      "theme item indexes mapped to real row ids",
      view?.themes[0].items.length === 2 &&
        view.themes[0].items.every((i) => i.id && i.title),
    ],
    ["isNew:false survived", view?.themes[1].isNew === false],
    [
      "valid people move mapped with evidence url",
      view?.people[0].person === "Jane Researcher" &&
        view.people[0].confidence === "confirmed" &&
        view.people[0].evidenceUrl === "https://example.com/a",
    ],
    [
      "invalid enum values coerced to safe defaults",
      view?.people[1].moveType === "other" &&
        view.people[1].confidence === "reported",
    ],
    [
      "out-of-range itemIndex did not crash or fabricate a link",
      view?.people[1].evidenceUrl === null,
    ],
    ["digest marked published", view?.status === "published"],
  ];

  let failed = 0;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? "✓" : "✗"} ${label}`);
    if (!ok) failed++;
  }

  // Fallback path: no provider configured must still produce a digest.
  delete process.env.OPENAI_API_KEY;
  const fallback = await synthesize(items, window);
  console.log(
    `  ${fallback.provider === "heuristic" ? "✓" : "✗"} falls back to heuristic when no key is set`,
  );
  if (fallback.provider !== "heuristic") failed++;

  console.log(
    failed === 0
      ? "\n✓ synthesis path verified\n"
      : `\n✗ ${failed} check(s) failed\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
