import { getDigestDates } from "@/db/queries";

export const revalidate = 600;

export const metadata = { title: "Archive — Trendwire" };

export default async function ArchivePage() {
  const dates = await getDigestDates(120).catch(() => []);

  return (
    <>
      <div className="folio">
        <span>Archive</span>
        <nav>
          <a href="/">Latest</a>
          <a href="/feed.xml">RSS</a>
        </nav>
      </div>

      <div className="section-rule">
        <h3>Every issue</h3>
      </div>

      {dates.length === 0 ? (
        <p className="empty">Nothing archived yet.</p>
      ) : (
        <ul className="archive">
          {dates.map((d) => (
            <li key={d.date}>
              <a href={`/digest/${d.date}`}>
                <span className="date">{d.date}</span>
                <span className="headline">
                  {d.headline ??
                    (d.status === "published"
                      ? "Untitled issue"
                      : `(${d.status})`)}
                </span>
                <span className="count">
                  {d.provider === "wire" ? "Wire · " : ""}
                  {d.itemCount} items
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
