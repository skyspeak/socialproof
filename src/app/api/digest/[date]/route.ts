import { NextResponse } from "next/server";
import { getDigest, getLatestDigestDate } from "@/db/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public JSON for a given date, or `latest`. */
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

  return NextResponse.json(digest, {
    headers: { "cache-control": "public, s-maxage=600, stale-while-revalidate=3600" },
  });
}
