import { getDigest, getDigestDates, getLatestDigestDate } from "@/db/queries";
import { DigestBody } from "@/components/DigestBody";

export const revalidate = 300;

export default async function Home() {
  let latest: string | null = null;
  let dbError: string | null = null;

  try {
    latest = await getLatestDigestDate();
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

  if (latest) {
    const digest = await getDigest(latest);
    if (digest) return <DigestBody digest={digest} />;
  }

  let unpublished = 0;
  if (!dbError) {
    unpublished = (await getDigestDates(5).catch(() => [])).length;
  }

  return (
    <article className="empty-issue">
      <header className="cover">
        <p className="vol">Waiting for press</p>
        <h1>
          <a href="/">Trendwire</a>
        </h1>
        <p className="banner">The day’s argument, without the sites</p>
        <h2 className="cover-hed">
          This morning’s issue has not been typeset yet.
        </h2>
      </header>
      <div className="letter">
        <p>
          The magazine publishes once a day. When the press run finishes, this
          page is the issue — cover, contents, and the rest — and you do not
          have to open anywhere else.
        </p>
      </div>
      {dbError ? (
        <p className="press-note">
          The database is not reachable. {dbError}
        </p>
      ) : unpublished ? (
        <p className="press-note">
          A digest row exists but has not reached published.
        </p>
      ) : (
        <p className="press-note">
          Trigger the daily pipeline when you want the first issue.
        </p>
      )}
    </article>
  );
}
