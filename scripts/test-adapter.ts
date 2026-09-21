/**
 * Adapter/registry invariants that should not need a network.
 *
 *   npx tsx scripts/test-adapter.ts
 */
import assert from "node:assert";
import { ALL_SOURCES } from "../src/ingest/registry";
import { withTimeout } from "../src/ingest/adapter";

async function main() {
  const checks: Array<[string, boolean]> = [];

  const slugs = ALL_SOURCES.map((s) => s.slug);
  checks.push([
    `source slugs are unique (${slugs.length})`,
    new Set(slugs).size === slugs.length,
  ]);
  checks.push(["registry has more than the original 18 sources", slugs.length >= 28]);
  checks.push([
    "new sources are registered",
    ["404media", "techcrunch", "bsky", "huggingface-papers", "platformer"].every(
      (s) => slugs.includes(s),
    ),
  ]);

  let timedOut = false;
  try {
    await withTimeout(new Promise(() => {}), 25, "probe");
  } catch (err) {
    timedOut = err instanceof Error && err.message.includes("timed out");
  }
  checks.push(["withTimeout rejects when the source hangs", timedOut]);

  const raced = await withTimeout(Promise.resolve("ok"), 1_000, "fast");
  checks.push(["withTimeout returns when the source finishes", raced === "ok"]);

  let failed = 0;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? "✓" : "✗"} ${label}`);
    if (!ok) failed++;
  }
  console.log(
    failed === 0 ? "\n✓ adapter invariants verified\n" : `\n✗ ${failed} check(s) failed\n`,
  );
  assert.equal(failed, 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
