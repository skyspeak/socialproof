import type { DigestView } from "@/db/queries";
import { isWeekendEdition } from "@/lib/continuity";

const MOVE_LABEL: Record<string, string> = {
  departure: "Departure",
  new_role: "New role",
  founded: "Founded",
  promoted: "Promoted",
  board: "Board",
  funding: "Funding",
  layoff: "Layoff",
  other: "Move",
};

function formatDate(dateKey: string): string {
  const d = new Date(`${dateKey}T12:00:00Z`);
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function DigestBody({ digest }: { digest: DigestView }) {
  const failed = digest.sourceHealth.filter((s) => s.status === "failed");
  const weekend = isWeekendEdition(digest.date);
  const isWire = digest.edition === "wire";
  const minute = isWire
    ? []
    : digest.themes
        .filter((t) => t.soWhat)
        .slice(0, 3)
        .map((t) => ({ name: t.name, soWhat: t.soWhat as string }));

  return (
    <>
      <div className="folio">
        <span>{formatDate(digest.date)}</span>
        <nav>
          {digest.prevDate ? (
            <a href={`/digest/${digest.prevDate}`}>Previous</a>
          ) : null}
          {digest.nextDate ? (
            <a href={`/digest/${digest.nextDate}`}>Next</a>
          ) : null}
          <a href="/archive">Archive</a>
          <a href={`/api/digest/${digest.date}`}>JSON</a>
          <a href="/feed.xml">RSS</a>
        </nav>
      </div>

      {isWire ? (
        <p className="banner wire">
          Wire edition. The model did not produce an editorial issue. Ranked
          intake follows — not clustered themes.
        </p>
      ) : null}

      {weekend ? (
        <p className="banner weekend">
          Weekend edition. arXiv uses a 96-hour lookback because it does not
          post on Saturday or Sunday; duplicates from Friday are collapsed.
        </p>
      ) : null}

      <section className="lede">
        <div>
          <div className="kicker">
            {isWire ? "Lead item" : "The day in one line"}
          </div>
          <h2>{digest.headline ?? "No single story dominated."}</h2>
          {digest.intro ? <p className="intro">{digest.intro}</p> : null}
        </div>
        <aside className="rail">
          <dl>
            <dt>Items</dt>
            <dd>{digest.itemCount}</dd>
            <dt>{isWire ? "On the wire" : "Themes"}</dt>
            <dd>{digest.themes.length}</dd>
            <dt>People</dt>
            <dd>{digest.people.length}</dd>
            <dt>Window</dt>
            <dd>
              {digest.windowStart.toISOString().slice(5, 16).replace("T", " ")} →{" "}
              {digest.windowEnd.toISOString().slice(5, 16).replace("T", " ")} UTC
            </dd>
            <dt>Sources</dt>
            <dd>
              {digest.sourceHealth.filter((s) => s.status === "ok").length}/
              {digest.sourceHealth.length} live
            </dd>
          </dl>
        </aside>
      </section>

      {minute.length ? (
        <>
          <div className="section-rule">
            <h3>If you only have a minute</h3>
          </div>
          <ol className="minute">
            {minute.map((m) => (
              <li key={m.name}>
                <strong>{m.name}.</strong> {m.soWhat}
              </li>
            ))}
          </ol>
        </>
      ) : null}

      <div className="section-rule">
        <h3>{isWire ? "The wire" : "What the day argued about"}</h3>
      </div>

      {digest.themes.length === 0 ? (
        <p className="empty">No themes were synthesized for this date.</p>
      ) : (
        <div className="themes">
          {digest.themes.map((theme) => (
            <article className="theme" key={theme.id}>
              <span className={theme.isNew ? "tag new" : "tag"}>
                {theme.isNew ? "New today" : "Ongoing"}
              </span>
              {theme.continuedFrom ? (
                <span className="continued">
                  Continued from {theme.continuedFrom.date}
                </span>
              ) : null}
              <h4>{theme.name}</h4>
              {theme.desks.length >= 2 ? (
                <p className="desks">{theme.desks.join(" · ")}</p>
              ) : null}
              <p>{theme.summary}</p>
              {theme.soWhat ? <p className="so-what">{theme.soWhat}</p> : null}
              {theme.items.length ? (
                <ul className="sources">
                  {theme.items.map((item) => (
                    <li key={item.id}>
                      <a
                        href={item.url ?? item.discussionUrl ?? "#"}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {item.title.length > 110
                          ? `${item.title.slice(0, 110)}…`
                          : item.title}
                      </a>
                      <span className="meta">
                        {item.sourceName}
                        {item.score != null ? ` · ${item.score}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </article>
          ))}
        </div>
      )}

      <div className="section-rule">
        <h3>People moves</h3>
      </div>

      {digest.people.length === 0 ? (
        <p className="empty">
          No people moves met the bar today. Nothing was manufactured to fill the
          section.
        </p>
      ) : (
        <div className="people">
          {digest.people.map((m) => (
            <article className="move" key={m.id}>
              <div className="who">
                {m.evidenceUrl ? (
                  <a
                    href={m.evidenceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ textDecoration: "none" }}
                  >
                    {m.person}
                  </a>
                ) : (
                  m.person
                )}
              </div>
              <p className="path">
                <span className={`conf ${m.confidence}`}>{m.confidence}</span>
                {" · "}
                {MOVE_LABEL[m.moveType] ?? "Move"}
                {m.fromOrg ? (
                  <>
                    <span className="arrow">·</span>
                    {m.fromOrg}
                  </>
                ) : null}
                {m.toOrg ? (
                  <>
                    <span className="arrow">→</span>
                    {m.toOrg}
                  </>
                ) : null}
                {m.role ? ` (${m.role})` : ""}
              </p>
              {m.note ? <p className="note">{m.note}</p> : null}
            </article>
          ))}
        </div>
      )}

      <div className="section-rule">
        <h3>Source health</h3>
      </div>

      <div className="health">
        {digest.sourceHealth.map((s) => (
          <span key={s.slug} className={s.status} title={s.error ?? undefined}>
            {s.slug} · {s.status}
            {s.itemsFound ? ` (${s.itemsFound})` : ""}
          </span>
        ))}
      </div>

      {failed.length ? (
        <p className="health-note">
          {failed.length} source{failed.length === 1 ? "" : "s"} failed this run.
          The digest is built from what did return — nothing was substituted
          silently.
        </p>
      ) : null}
    </>
  );
}
