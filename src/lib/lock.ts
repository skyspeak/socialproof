import { and, eq, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { locks } from "@/db/schema";
import { randomUUID } from "node:crypto";

/**
 * Lease-based mutual exclusion for pipeline runs.
 *
 * Acquire is a single atomic statement: insert the lease, or take it over only
 * if the existing one has expired. Two simultaneous cron invocations therefore
 * cannot both win — one gets the row, the other gets nothing.
 *
 * The lease is deliberately short-lived relative to the work: if a function is
 * killed mid-run (timeout, deploy, OOM) nothing has to clean up, because the
 * lease expires on its own and the next tick resumes the digest.
 */
export type Lease = { name: string; holder: string };

export async function acquireLock(
  name: string,
  ttlMs: number,
): Promise<Lease | null> {
  const db = await getDb();
  const holder = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);

  const rows = await db
    .insert(locks)
    .values({ name, holder, acquiredAt: now, expiresAt })
    .onConflictDoUpdate({
      target: locks.name,
      set: { holder, acquiredAt: now, expiresAt },
      // The guard that makes this safe: only steal an expired lease.
      where: lt(locks.expiresAt, now),
    })
    .returning({ holder: locks.holder });

  if (rows.length === 0 || rows[0].holder !== holder) return null;
  return { name, holder };
}

/** Extend a held lease — call between chunks on long runs. */
export async function renewLock(lease: Lease, ttlMs: number): Promise<boolean> {
  const db = await getDb();
  const rows = await db
    .update(locks)
    .set({ expiresAt: new Date(Date.now() + ttlMs) })
    .where(and(eq(locks.name, lease.name), eq(locks.holder, lease.holder)))
    .returning({ holder: locks.holder });
  return rows.length > 0;
}

/** Release only if we still hold it — never stomp a lease someone else took. */
export async function releaseLock(lease: Lease): Promise<void> {
  const db = await getDb();
  await db
    .delete(locks)
    .where(and(eq(locks.name, lease.name), eq(locks.holder, lease.holder)));
}

export async function inspectLock(
  name: string,
): Promise<{ holder: string; expiresAt: Date; expired: boolean } | null> {
  const db = await getDb();
  const [row] = await db.select().from(locks).where(eq(locks.name, name)).limit(1);
  if (!row) return null;
  return {
    holder: row.holder,
    expiresAt: row.expiresAt,
    expired: row.expiresAt.getTime() < Date.now(),
  };
}

/** Run `fn` under a lease, or return null if another run holds it. */
export async function withLock<T>(
  name: string,
  ttlMs: number,
  fn: (lease: Lease) => Promise<T>,
): Promise<T | null> {
  const lease = await acquireLock(name, ttlMs);
  if (!lease) return null;
  try {
    return await fn(lease);
  } finally {
    await releaseLock(lease).catch(() => {
      // Losing the release is survivable — the lease expires on its own.
    });
  }
}
