import { getDigest, getDigestDates, getLatestDigestDate } from "@/db/queries";
import { DigestBody } from "@/components/DigestBody";

/**
 * Cached for 5 minutes. The digest changes once a day, so serving every visitor
 * a fresh Postgres round trip would waste Neon compute hours — which are the
 * metered resource on the free plan (100 CU-hours/project/month), not requests.
 */
export const revalidate = 300;

export default async function Home() {
  let latest: string | null = null;
  let fallbackDates: Awaited<ReturnType<typeof getDigestDates>> = [];

  try {
    latest = await getLatestDigestDate();
    if (!latest) fallbackDates = await getDigestDates(5);
  } catch (err) {
    return (
      <div className="empty">
        <p>The database isn&apos;t reachable yet.</p>
        <p>
          Set <code>DATABASE_URL</code>, run <code>npm run db:push</code>, then
          trigger <code>/api/cron/digest</code>.
        </p>
        <p style={{ fontSize: "0.8rem" }}>
          {err instanceof Error ? err.message : String(err)}
        </p>
      </div>
    );
  }

  if (!latest) {
    return (
      <div className="empty">
        <p>No digest has been published yet.</p>
        <p>
          {fallbackDates.length
            ? `${fallbackDates.length} digest row(s) exist but none reached "published".`
            : "Trigger the pipeline with a GET to /api/cron/digest."}
        </p>
      </div>
    );
  }

  const digest = await getDigest(latest);
  if (!digest) {
    return <div className="empty">Digest missing for {latest}.</div>;
  }

  return <DigestBody digest={digest} />;
}
