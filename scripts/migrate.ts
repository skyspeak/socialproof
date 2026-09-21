/**
 * Apply migrations to a real Postgres (Supabase, RDS, anything).
 *
 *   npm run db:migrate
 *
 * Runs the versioned .sql files in ./drizzle and records them in
 * drizzle.__drizzle_migrations, so it is safe to re-run and safe in CI.
 *
 * Prefers a direct (or session-mode) connection, because DDL must not go
 * through a transaction-mode pooler. Supabase's runtime URL is Supavisor on
 * port 6543; that mode does not support SET/RESET, SQL-level PREPARE, or
 * session-level advisory locks.
 *
 * Resolution order:
 *   POSTGRES_URL_NON_POOLING  (Supabase's Vercel integration)
 *   DATABASE_URL_UNPOOLED     (legacy name, still honored)
 *   DIRECT_DATABASE_URL       (manual / .env.example)
 *   DIRECT_URL                (Prisma / Supabase CLI convention)
 *   DATABASE_URL / POSTGRES_URL  (last resort — warned if it looks pooled)
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

function isTransactionPooler(url: string): boolean {
  try {
    const parsed = new URL(url);
    const port = parsed.port || "5432";
    if (port === "6543") return true;
    return parsed.hostname.includes("-pooler");
  } catch {
    return url.includes(":6543") || url.includes("-pooler");
  }
}

async function main() {
  const direct =
    process.env.POSTGRES_URL_NON_POOLING ??
    process.env.DATABASE_URL_UNPOOLED ??
    process.env.DIRECT_DATABASE_URL ??
    process.env.DIRECT_URL;
  const pooled = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  const url = direct ?? pooled;

  if (!url) {
    console.error(
      "✗ No connection string. Set DIRECT_DATABASE_URL (or the integration\n" +
        "  var POSTGRES_URL_NON_POOLING), then DATABASE_URL as a fallback.",
    );
    process.exit(1);
  }

  if (url.startsWith("pglite://")) {
    console.error(
      "✗ This script targets a real Postgres server.\n" +
        "  For local work run `npm run digest:local`, which applies the schema to PGlite itself.",
    );
    process.exit(1);
  }

  if (!direct && isTransactionPooler(url)) {
    console.warn(
      "⚠ DATABASE_URL looks like a transaction-mode pooler (port 6543, or a\n" +
        "  *-pooler hostname) and no direct string is set. Migrations should\n" +
        "  use db.<project>.supabase.co:5432, or the Session pooler on 5432.\n" +
        "  Continuing, but some statements may fail under transaction pooling.\n",
    );
  }

  // max: 1 — migrations are strictly sequential, and a single connection avoids
  // two runners racing the migration table.
  const client = postgres(url, { max: 1, prepare: false });
  const db = drizzle(client);

  const startedAt = Date.now();
  try {
    await migrate(db, { migrationsFolder: "./drizzle" });
    console.log(`✓ migrations applied in ${Date.now() - startedAt}ms`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("✗ migration failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
