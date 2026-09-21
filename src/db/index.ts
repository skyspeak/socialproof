import * as schema from "./schema";

/**
 * Two drivers, one interface.
 *
 *  - Production (Vercel): `postgres://...` → postgres-js against Supabase.
 *  - Local verification:  `pglite://<dir>` → PGlite, real Postgres compiled to WASM,
 *    which lets the whole pipeline be exercised without a server running.
 *
 * Both are wrapped by Drizzle so query code is identical either way.
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

type Schema = typeof schema;
/**
 * Both drivers expose the same Drizzle query surface; we standardize on the
 * postgres-js type so callers keep full inference and the PGlite instance is
 * cast to it at the single boundary below.
 */
export type Db = PostgresJsDatabase<Schema>;

let cached: Promise<Db> | null = null;

async function create(): Promise<Db> {
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env and fill it in.",
    );
  }

  if (url.startsWith("pglite://")) {
    const dir = url.slice("pglite://".length) || "./.pglite";
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const client = new PGlite(dir);
    await client.waitReady;
    return drizzle(client, { schema }) as unknown as Db;
  }


  const postgres = (await import("postgres")).default;
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const client = postgres(url, {
    // Small pool: the process is reused across requests under Fluid compute,
    // but Supabase's transaction pooler (port 6543) is what absorbs concurrency.
    max: 3,
    idle_timeout: 20,
    connect_timeout: 15,
    // REQUIRED against Supavisor in transaction mode. That mode does not
    // support SQL-level PREPARE/DEALLOCATE; leaving prepared statements on
    // produces intermittent errors under load.
    prepare: false,
  });
  return drizzle(client, { schema }) as Db;
}

/**
 * Why postgres-js (TCP) rather than an HTTP driver:
 *
 * This pipeline issues hundreds of sequential upserts inside a single long
 * invocation, and Fluid compute keeps the instance warm across requests, so a
 * pooled TCP connection amortizes better than one-shot HTTP. Migrations are
 * the exception: they must not run through the transaction pooler. See
 * scripts/migrate.ts.
 */

export function getDb(): Promise<Db> {
  if (!cached) cached = create();
  return cached;
}

export { schema };
