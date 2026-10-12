/**
 * The Gemini model ladder, against a local stub.
 *
 * Production, October: gemini-2.5-pro answered 404 "no longer available to new
 * users", gemini-2.5-flash answered 429, and on days the model did answer, the
 * JSON was cut off at a 5,000-token limit that thinking tokens share. Each of
 * those is a case below.
 *
 *   npx tsx scripts/test-gemini-ladder.ts
 */
import { createServer } from "node:http";

let failed = 0;
function check(label: string, ok: boolean) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failed++;
}

type Reply = { status: number; body: unknown };
const ok = (text: string, extra: Record<string, unknown> = {}): Reply => ({
  status: 200,
  body: { candidates: [{ finishReason: "STOP", content: { parts: [{ text }] }, ...extra }] },
});

let plan: Record<string, Reply> = {};
let seen: Array<{ model: string; maxOutputTokens: number }> = [];

const server = createServer((req, res) => {
  const model = /\/models\/([^:]+):generateContent/.exec(req.url ?? "")?.[1] ?? "?";
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw);
    seen.push({ model, maxOutputTokens: body.generationConfig?.maxOutputTokens });
    const reply = plan[model] ?? { status: 404, body: { error: { code: 404, message: "no such model" } } };
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(JSON.stringify(reply.body));
  });
});

async function main() {
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;

  for (const k of ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "LLM_PROVIDER", "GEMINI_MODEL"]) {
    delete process.env[k];
  }
  process.env.GEMINI_API_KEY = "test-key";
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${port}/v1beta`;

  const { completeJson, geminiConfigSummary } = await import("../src/synth/llm");
  const run = async (p: Record<string, Reply>) => {
    plan = p;
    seen = [];
    try {
      const r = await completeJson("sys", "user", 5000);
      return { ok: true as const, text: r.text, error: "" };
    } catch (e) {
      return { ok: false as const, text: "", error: e instanceof Error ? e.message : String(e) };
    }
  };
  const order = () => seen.map((s) => s.model).join(",");

  const ladder = geminiConfigSummary().modelLadder;
  check("the default ladder leads with the current pro model", ladder[0] === "gemini-3.1-pro-preview");
  check("retired gemini-2.5-pro is no longer first", ladder[0] !== "gemini-2.5-pro");
  check("flash is on the ladder", ladder.includes("gemini-2.5-flash"));

  // 1. the first model works
  let r = await run({ "gemini-3.1-pro-preview": ok('{"a":1}') });
  check("a working first model is used once", r.ok && seen.length === 1);

  // 2. 404 (retired) moves on
  r = await run({ "gemini-2.5-flash": ok('{"via":"flash"}') });
  check("404 on the first model moves to the next", r.ok && /flash/.test(r.text) && order().startsWith("gemini-3.1-pro-preview,gemini-2.5-flash"));

  // 3. 429 (that model's quota) moves on
  r = await run({
    "gemini-3.1-pro-preview": { status: 429, body: { error: { message: "You exceeded your current quota" } } },
    "gemini-2.5-flash": ok('{"via":"flash"}'),
  });
  check("429 moves to the next model", r.ok && /flash/.test(r.text));

  // 4. 503 moves on
  r = await run({
    "gemini-3.1-pro-preview": { status: 503, body: { error: { message: "overloaded" } } },
    "gemini-2.5-flash": ok('{"via":"flash"}'),
  });
  check("503 moves to the next model", r.ok && /flash/.test(r.text));

  // 5. an answer cut off at the token limit moves on and is named as such
  r = await run({
    "gemini-3.1-pro-preview": ok('{"themes":[{"name":"a"', { finishReason: "MAX_TOKENS" }),
    "gemini-2.5-flash": ok('{"via":"flash"}'),
  });
  check("a MAX_TOKENS answer moves to the next model", r.ok && /flash/.test(r.text));

  // 6. unparseable JSON moves on
  r = await run({
    "gemini-3.1-pro-preview": ok('{"themes":[{"name":"a"},{'),
    "gemini-2.5-flash": ok('{"via":"flash"}'),
  });
  check("invalid JSON moves to the next model", r.ok && /flash/.test(r.text));

  // 7. thought parts are not the answer
  r = await run({
    "gemini-3.1-pro-preview": {
      status: 200,
      body: {
        candidates: [
          { finishReason: "STOP", content: { parts: [{ thought: true, text: "let me think {not json" }, { text: '{"answer":true}' }] } },
        ],
      },
    },
  });
  check("thought parts are ignored", r.ok && r.text === '{"answer":true}');

  // 8. a bad key stops immediately, no ladder
  r = await run({
    "gemini-3.1-pro-preview": { status: 400, body: { error: { message: "API key not valid. Please pass a valid API key." } } },
    "gemini-2.5-flash": ok('{"never":"reached"}'),
  });
  check("a bad API key stops the ladder", !r.ok && seen.length === 1);
  check("the bad-key error says what happened", /API key not valid/.test(r.error));

  // 9. a refused prompt stops immediately
  r = await run({
    "gemini-3.1-pro-preview": { status: 200, body: { promptFeedback: { blockReason: "SAFETY" }, candidates: [] } },
    "gemini-2.5-flash": ok('{"never":"reached"}'),
  });
  check("a blocked prompt stops the ladder", !r.ok && seen.length === 1 && /blocked/.test(r.error));

  // 10. everything fails: every attempt is in the error
  r = await run({
    "gemini-3.1-pro-preview": { status: 404, body: { error: { message: "gone" } } },
    "gemini-2.5-flash": { status: 429, body: { error: { message: "quota" } } },
    "gemini-2.5-pro": ok("not json at all"),
  });
  check("when everything fails the call fails", !r.ok);
  check("the error names every model tried", ladder.every((m) => r.error.includes(m)));
  check("the error says why each one failed", /404/.test(r.error) && /429/.test(r.error) && /not valid JSON/.test(r.error));

  // 11. the output budget is raised above what the caller asked for
  await run({ "gemini-3.1-pro-preview": ok('{"a":1}') });
  check("the request asks for a larger output budget than the caller's 5,000", seen[0].maxOutputTokens >= 16000);

  server.close();
  console.log(failed === 0 ? "\n✓ gemini ladder verified\n" : `\n✗ ${failed} check(s) failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
