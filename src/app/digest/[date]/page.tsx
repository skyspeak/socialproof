import { notFound } from "next/navigation";
import { getDigest } from "@/db/queries";
import { isValidDateKey } from "@/lib/window";
import { DigestBody } from "@/components/DigestBody";

/**
 * A published issue never changes, so it can be cached hard. An hour keeps
 * same-day corrections (a re-run of today's date) from being pinned forever.
 */
export const revalidate = 3600;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ date: string }>;
}) {
  const { date } = await params;
  const digest = await getDigest(date).catch(() => null);
  return {
    title: digest?.headline
      ? `${digest.headline} — Trendwire ${date}`
      : `Trendwire — ${date}`,
    description: digest?.intro ?? undefined,
  };
}

export default async function DigestPage({
  params,
}: {
  params: Promise<{ date: string }>;
}) {
  const { date } = await params;

  // A calendar-invalid but digit-shaped date (2026-02-30) already ends in
  // notFound() via the .catch() below — Postgres rejects the literal and the
  // error is swallowed. Checking here just skips that wasted round trip.
  if (!isValidDateKey(date)) notFound();

  const digest = await getDigest(date).catch(() => null);
  if (!digest) notFound();

  return <DigestBody digest={digest} />;
}
