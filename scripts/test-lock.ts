/**
 * Verifies the lease lock, which is what stops two overlapping cron invocations
 * from ingesting the same day twice. Vercel does not deduplicate cron runs, so
 * this is load-bearing rather than defensive.
 *
 *   npx tsx scripts/test-lock.ts
 */
import assert from "node:assert";

process.env.DATABASE_URL = "pglite://./.pglite-lock-test";

async function main() {
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

  const { acquireLock, releaseLock, renewLock, inspectLock, withLock } =
    await import("../src/lib/lock");

  const checks: Array<[string, boolean]> = [];

  // 1. First acquire wins.
  const a = await acquireLock("test", 60_000);
  checks.push(["first caller acquires the lease", a !== null]);

  // 2. Second acquire is refused while the lease is live.
  const b = await acquireLock("test", 60_000);
  checks.push(["second caller is refused while held", b === null]);

  // 3. Two simultaneous acquires: exactly one wins.
  await releaseLock(a!);
  const racers = await Promise.all([
    acquireLock("race", 60_000),
    acquireLock("race", 60_000),
    acquireLock("race", 60_000),
    acquireLock("race", 60_000),
  ]);
  const winners = racers.filter((r) => r !== null);
  checks.push([
    `exactly one of four concurrent acquires wins (got ${winners.length})`,
    winners.length === 1,
  ]);

  // 4. Renewal extends the lease.
  const before = await inspectLock("race");
  await new Promise((r) => setTimeout(r, 30));
  const renewed = await renewLock(winners[0]!, 120_000);
  const after = await inspectLock("race");
  checks.push([
    "holder can renew and the expiry moves forward",
    renewed && after!.expiresAt.getTime() > before!.expiresAt.getTime(),
  ]);

  // 5. A non-holder cannot renew.
  const impostorRenew = await renewLock(
    { name: "race", holder: "not-the-holder" },
    60_000,
  );
  checks.push(["a non-holder cannot renew", impostorRenew === false]);

  // 6. A non-holder's release does not free the lease.
  await releaseLock({ name: "race", holder: "not-the-holder" });
  const stillHeld = await inspectLock("race");
  checks.push(["a non-holder's release is a no-op", stillHeld !== null]);

  // 7. An EXPIRED lease can be taken over — the crash-recovery path. If this
  //    failed, a function killed mid-run would wedge the pipeline permanently.
  const expiring = await acquireLock("expiry", -1_000); // already expired
  checks.push(["can acquire with an already-past expiry", expiring !== null]);
  const takeover = await acquireLock("expiry", 60_000);
  checks.push(["an expired lease is stealable", takeover !== null]);

  // 8. withLock returns null instead of running the body when contended.
  await acquireLock("wrapped", 60_000);
  let ran = false;
  const result = await withLock("wrapped", 60_000, async () => {
    ran = true;
    return "should not happen";
  });
  checks.push(["withLock skips the body when contended", result === null && !ran]);

  // 9. withLock releases on throw, so a failure doesn't wedge the lease.
  await releaseLock((await inspectLock("wrapped"))
    ? { name: "wrapped", holder: (await inspectLock("wrapped"))!.holder }
    : { name: "wrapped", holder: "" });
  await withLock("throwing", 60_000, async () => {
    throw new Error("boom");
  }).catch(() => {});
  const afterThrow = await inspectLock("throwing");
  checks.push(["lease is released even when the body throws", afterThrow === null]);

  let failed = 0;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? "✓" : "✗"} ${label}`);
    if (!ok) failed++;
  }

  console.log(
    failed === 0 ? "\n✓ lock verified\n" : `\n✗ ${failed} check(s) failed\n`,
  );
  assert.equal(failed, 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
