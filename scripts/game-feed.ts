/**
 * Write a game feed to a file, without a deployment.
 *
 * `/api/game-feed/:date` is the normal path, but it needs the app running
 * against a real database. This produces exactly the same document from
 * whatever `DATABASE_URL` points at — including a local PGlite directory — so
 * the games can be fed from a laptop run before anything is deployed, and so a
 * feed can be regenerated from the archive later without the network.
 *
 *   DATABASE_URL="pglite://./.pglite-live" npx tsx scripts/game-feed.ts
 *   npx tsx scripts/game-feed.ts --date 2026-09-20 --out feed.json
 *
 * With --out it writes the file; otherwise it prints to stdout.
 */
import { writeFileSync } from "node:fs";
import { getDigest, getIntakeItems, getLatestDigestDate } from "../src/db/queries";
import { buildGameFeed } from "../src/lib/gamefeed";

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function main() {
  const wanted = arg("--date") ?? (await getLatestDigestDate());
  if (!wanted) {
    console.error("no published digest in this database");
    process.exit(1);
  }

  const digest = await getDigest(wanted);
  if (!digest) {
    console.error(`no digest for ${wanted}`);
    process.exit(1);
  }
  if (digest.status !== "published") {
    console.error(`${wanted} is ${digest.status}, not published`);
    process.exit(1);
  }

  const intake = await getIntakeItems(wanted);
  const feed = buildGameFeed(digest, intake);
  const json = JSON.stringify(feed, null, 1) + "\n";

  const out = arg("--out");
  if (out) {
    writeFileSync(out, json);
    console.error(
      `${out}: ${feed.date} ${feed.edition} · ${intake.length} intake · ${feed.terms.length} terms · ` +
        `${feed.orgs.length} orgs · ${feed.moves.length} confirmed moves ` +
        `(of ${feed.counts.movesInIssue} in the issue)`,
    );
  } else {
    process.stdout.write(json);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
