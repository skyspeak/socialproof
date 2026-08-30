import { getDigestDates } from "@/db/queries";

export const revalidate = 600;

export const metadata = { title: "Back issues — Trendwire" };

function formatDate(dateKey: string): string {
  const d = new Date(`${dateKey}T12:00:00Z`);
  return d.toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export default async function ArchivePage() {
  const dates = await getDigestDates(120).catch(() => []);
  const issues = dates.filter((d) => d.status === "published");

  return (
    <>
      <header className="mast-compact">
        <a href="/">Trendwire</a>
        <span>Back issues</span>
      </header>

      <h3 className="hed">The stack</h3>

      {issues.length === 0 ? (
        <p className="quiet">Nothing in the stack yet.</p>
      ) : (
        <ul className="archive">
          {issues.map((d) => (
            <li key={d.date}>
              <a href={`/digest/${d.date}`}>
                <span className="date">{formatDate(d.date)}</span>
                <span className="headline">
                  {d.headline ?? "Untitled issue"}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
