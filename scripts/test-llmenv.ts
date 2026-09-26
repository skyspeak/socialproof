/**
 * Env-value hygiene for the LLM providers. A model name with stray quotes or
 * whitespace lands in a URL path and Google answers 400 "unexpected model name
 * format" — found in production, where it left every issue a wire edition.
 *
 *   npx tsx scripts/test-llmenv.ts
 */
import { cleanEnv, modelName } from "../src/synth/llm";

let failed = 0;
function check(label: string, ok: boolean) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failed++;
}
const D = "gemini-2.5-pro";

check("a clean name passes through", modelName("gemini-2.5-flash", D) === "gemini-2.5-flash");
check("wrapping double quotes are stripped", modelName('"gemini-2.5-pro"', D) === "gemini-2.5-pro");
check("wrapping single quotes are stripped", modelName("'gemini-2.5-pro'", D) === "gemini-2.5-pro");
check("trailing newline is stripped", modelName("gemini-2.5-pro\n", D) === "gemini-2.5-pro");
check("surrounding spaces are stripped", modelName("  gemini-2.5-pro  ", D) === "gemini-2.5-pro");
check("a models/ prefix is stripped", modelName("models/gemini-2.5-pro", D) === "gemini-2.5-pro");
check("unset falls back", modelName(undefined, D) === D);
check("empty falls back", modelName("", D) === D);
check("quotes around nothing fall back", modelName('""', D) === D);
check("a name with a space inside falls back", modelName("gemini 2.5 pro", D) === D);
check("a name with a slash inside falls back", modelName("a/b/c", D) === D);
check("a name with a colon falls back", modelName("gemini:generateContent", D) === D);
check("cleanEnv trims a key", cleanEnv(" abc123\n") === "abc123");
check("cleanEnv of blank is undefined", cleanEnv("   ") === undefined);

console.log(failed === 0 ? "\n✓ llm env verified\n" : `\n✗ ${failed} check(s) failed\n`);
process.exit(failed === 0 ? 0 : 1);
