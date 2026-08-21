/**
 * End-to-end local verification.
 *
 * Spins up PGlite (real Postgres, WASM), applies the schema, runs the full
 * pipeline against live sources, and prints the resulting digest. This is the
 * harness used to prove the pipeline works before any deploy.
 *
 *   npm run digest:local
 */
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";

process.env.DATABASE_URL ??= "pglite://./.pglite";

async function applySchema() {
  const { PGlite } = await import("@electric-sql/pglite");
  const dir = process.env.DATABASE_URL!.slice("pglite://".length);
  mkdirSync(dir, { recursive: true });

  const client = new PGlite(dir);
  await client.waitReady;

  const migrationsDir = join(process.cwd(), "drizzle");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    throw new Error("No migrations found. Run `npm run db:generate` first.");
  }

  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    // drizzle-kit separates statements with this marker.
    const statements = sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);

    for (const statement of statements) {
      try {
        await client.exec(statement);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Re-running the harness against an existing dir is fine.
        if (!/already exists/i.test(msg)) throw err;
      }
    }
  }

  await client.close();
  console.log(`✓ schema applied (${files.length} migration file(s))`);
}

async function main() {
  await applySchema();

  const { runToCompletion } = await import("../src/pipeline");
  const { windowFor } = await import("../src/lib/window");
  const { getDigest } = await import("../src/db/queries");

  const window = windowFor(new Date());
  console.log(
    `\nWindow: ${window.start.toISOString()} → ${window.end.toISOString()}\n`,
  );

  const final = await runToCompletion(window, (r) => {
    if (r.batchOutcomes.length) {
      for (const o of r.batchOutcomes) {
        const mark =
          o.status === "ok" ? "✓" : o.status === "failed" ? "✗" : "·";
        console.log(
          `  ${mark} ${o.slug.padEnd(22)} ${String(o.itemsFound).padStart(3)} items  ${o.durationMs}ms${
            o.error ? `  — ${o.error.slice(0, 80)}` : ""
          }`,
        );
      }
    }
  });

  console.log(
    `\n✓ synthesis complete via ${final.provider}: ${final.themeCount} themes, ${final.peopleCount} people moves, ${final.itemCount} items\n`,
  );

  const digest = await getDigest(window.date);
  if (!digest) throw new Error("digest not found after run");

  console.log("─".repeat(72));
  console.log(`HEADLINE: ${digest.headline}`);
  console.log(`\n${digest.intro}\n`);
  for (const t of digest.themes) {
    console.log(`\n▸ ${t.name}  [${t.isNew ? "new" : "ongoing"}]`);
    console.log(`  ${t.summary}`);
    if (t.soWhat) console.log(`  → ${t.soWhat}`);
    for (const item of t.items.slice(0, 3)) {
      console.log(`     · ${item.title.slice(0, 88)} (${item.sourceName})`);
    }
  }
  if (digest.people.length) {
    console.log(`\nPEOPLE MOVES`);
    for (const p of digest.people) {
      console.log(
        `  · ${p.person} [${p.confidence}] ${p.fromOrg ?? "?"} → ${p.toOrg ?? "?"}`,
      );
    }
  }
  console.log("─".repeat(72));
  console.log("\nSource health:");
  for (const s of digest.sourceHealth) {
    console.log(`  ${s.status.padEnd(8)} ${s.slug} (${s.itemsFound})`);
  }
}

main().catch((err) => {
  console.error("\n✗ pipeline failed:", err);
  process.exit(1);
});
