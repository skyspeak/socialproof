import { NextResponse } from "next/server";
import { getDigest, getIntakeItems, getLatestDigestDate } from "@/db/queries";
import { buildGameFeed } from "@/lib/gamefeed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A flat, ranked, pre-filtered projection of an issue for downstream games.
 *
 * Consumers commit snapshots and need reproducible builds, so this is served
 * per date. `latest` exists for exploration; a build should never use it.
 *
 * Unpublished issues are refused. A half-ingested day would otherwise hand a
 * game a thin corpus that looks like a quiet news day rather than a partial run.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ date: string }> },
) {
  const { date } = await params;

  const key = date === "latest" ? await getLatestDigestDate() : date;
  if (!key) {
    return NextResponse.json({ error: "no published digest" }, { status: 404 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    return NextResponse.json({ error: "bad date" }, { status: 400 });
  }

  const digest = await getDigest(key);
  if (!digest) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (digest.status !== "published") {
    return NextResponse.json(
      { error: "not published", status: digest.status },
      { status: 409 },
    );
  }

  // The issue cites a few dozen items; the run ingested several hundred. A game
  // mining the day for vocabulary wants the wider set, weighted below the
  // editorial picks.
  const intake = await getIntakeItems(key);

  return NextResponse.json(buildGameFeed(digest, intake), {
    headers: {
      "cache-control": "public, s-maxage=600, stale-while-revalidate=3600",
      "access-control-allow-origin": "*",
    },
  });
}
