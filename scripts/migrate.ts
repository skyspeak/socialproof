/**
 * Apply migrations to a real Postgres (Neon, RDS, anything).
 *
 *   npm run db:migrate
 *
 * Runs the versioned .sql files in ./drizzle and records them in
 * drizzle.__drizzle_migrations, so it is safe to re-run and safe in CI.
 *
 * Prefers an unpooled connection, because DDL must not go through Neon's pooled
 * endpoint: it's PgBouncer in transaction mode, which explicitly does not
 * support SET/RESET, LOAD, SQL-level PREPARE, or session-level advisory locks —
 * and Neon's docs list "schema migrations" under use-a-direct-connection.
 *
 * `DATABASE_URL_UNPOOLED` is the name Neon's Vercel integration sets
 * automatically, so it's checked first; DIRECT_DATABASE_URL is the manual
 * equivalent for non-Vercel setups.
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

async function main() {
  const direct =
    process.env.DATABASE_URL_UNPOOLED ?? process.env.DIRECT_DATABASE_URL;
  const pooled = process.env.DATABASE_URL;
  const url = direct ?? pooled;

  if (!url) {
    console.error(
      "✗ No connection string. Set DATABASE_URL_UNPOOLED (set for you by the\n" +
        "  Neon Vercel integration), DIRECT_DATABASE_URL, or DATABASE_URL.",
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

  if (!direct && pooled?.includes("-pooler")) {
    console.warn(
      "⚠ DATABASE_URL points at Neon's pooled endpoint (-pooler) and no\n" +
        "  unpooled string is set. Migrations should use a direct connection.\n" +
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
