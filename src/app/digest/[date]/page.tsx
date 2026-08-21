import { notFound } from "next/navigation";
import { getDigest } from "@/db/queries";
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

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) notFound();

  const digest = await getDigest(date).catch(() => null);
  if (!digest) notFound();

  return <DigestBody digest={digest} />;
}
