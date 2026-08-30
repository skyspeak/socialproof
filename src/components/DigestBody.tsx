import type { DigestView, DigestItemView, ThemeView } from "@/db/queries";
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

function editionName(digest: DigestView): string {
  if (digest.edition === "wire") return "Wire edition";
  if (isWeekendEdition(digest.date)) return "Weekend edition";
  return "Morning edition";
}

function shortDate(dateKey: string): string {
  const d = new Date(`${dateKey}T12:00:00Z`);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function leadPhoto(items: DigestItemView[]): DigestItemView | null {
  return items.find((i) => i.imageUrl) ?? null;
}

export function DigestBody({
  digest,
  specimen = false,
}: {
  digest: DigestView;
  specimen?: boolean;
}) {
  const failed = digest.sourceHealth.filter((s) => s.status === "failed");
  const isWire = digest.edition === "wire";
  const [feature, ...rest] = digest.themes;
  const edition = editionName(digest);

  return (
    <article className="issue-body">
      <header className="cover">
        {specimen ? <p className="vol specimen">Specimen — not a press run</p> : null}
        <p className="vol">
          {edition} · {formatDate(digest.date)}
        </p>
        <h1>
          <a href="/">Trendwire</a>
        </h1>
        <p className="banner">The day’s argument, without the sites</p>
        <h2 className="cover-hed">
          {digest.headline ?? "No single story dominated."}
        </h2>
      </header>

      <nav className="folio" aria-label="Issue">
        <span>{edition}</span>
        <span>
          {digest.prevDate ? (
            <a href={`/digest/${digest.prevDate}`}>Previous</a>
          ) : null}
          {digest.nextDate ? (
            <a href={`/digest/${digest.nextDate}`}>Next</a>
          ) : null}
          <a href="/archive">Back issues</a>
        </span>
      </nav>

      {isWire ? (
        <p className="banner-ed wire">
          Wire edition. The model did not produce an editorial issue. Ranked
          intake follows — not clustered themes.
        </p>
      ) : null}

      {digest.themes.length ? (
        <>
          <h3 className="hed">Contents</h3>
          <ol className="toc">
            {digest.themes.map((theme, i) => (
              <li key={theme.id}>
                <a href={`#${theme.id}`}>
                  <span className="toc-num">{pad(i + 1)}</span>
                  <span className="toc-name">{theme.name}</span>
                  {theme.soWhat ? (
                    <span className="toc-deck">{theme.soWhat}</span>
                  ) : null}
                </a>
              </li>
            ))}
            {digest.people.length ? (
              <li>
                <a href="#appointments">
                  <span className="toc-num">—</span>
                  <span className="toc-name">Appointments</span>
                  <span className="toc-deck">
                    {digest.people.length}{" "}
                    {digest.people.length === 1 ? "move" : "moves"}
                  </span>
                </a>
              </li>
            ) : null}
            {digest.bookmarks.length ? (
              <li>
                <a href="#noted">
                  <span className="toc-num">—</span>
                  <span className="toc-name">Noted</span>
                  <span className="toc-deck">From your bookmarks</span>
                </a>
              </li>
            ) : null}
          </ol>
        </>
      ) : null}

      {digest.intro ? (
        <>
          <h3 className="hed">The day</h3>
          <div className="letter">
            <p>{digest.intro}</p>
          </div>
        </>
      ) : null}

      {digest.themes.length === 0 ? (
        <p className="quiet">No themes were typeset for this date.</p>
      ) : (
        <>
          {feature ? <Feature theme={feature} index={0} /> : null}
          {rest.map((theme, i) => (
            <Piece theme={theme} index={i + 1} key={theme.id} />
          ))}
        </>
      )}

      {digest.people.length ? (
        <section id="appointments">
          <h3 className="hed">Appointments</h3>
          <div className="gazette">
            {digest.people.map((m) => (
              <article className="move" key={m.id}>
                <div className="who">
                  {m.evidenceUrl ? (
                    <a
                      href={m.evidenceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
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
                      <span className="arrow">from</span>
                      {m.fromOrg}
                    </>
                  ) : null}
                  {m.toOrg ? (
                    <>
                      <span className="arrow">to</span>
                      {m.toOrg}
                    </>
                  ) : null}
                  {m.role ? ` · ${m.role}` : ""}
                </p>
                {m.note ? <p className="note">{m.note}</p> : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {digest.bookmarks.length ? (
        <section id="noted">
          <h3 className="hed">Noted</h3>
          <p className="kicker-line">Held from the stream so they could be read here.</p>
          <div className="noted">
            {digest.bookmarks.map((b) => (
              <article className="clip" key={b.tweetId}>
                <p className="clip-byline">
                  <a href={b.tweetUrl} target="_blank" rel="noopener noreferrer">
                    {b.author ? `@${b.author}` : "Saved"}
                  </a>
                </p>
                {b.text ? <p className="clip-text">{b.text}</p> : null}
                {b.images.length ? (
                  <div className={`clip-images count-${Math.min(b.images.length, 3)}`}>
                    {b.images.map((src) => (
                      <a
                        key={src}
                        href={src}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <img src={src} alt="" referrerPolicy="no-referrer" />
                      </a>
                    ))}
                  </div>
                ) : null}
                {b.links.length ? (
                  <ul className="further">
                    {b.links.map((href) => (
                      <li key={href}>
                        <a href={href} target="_blank" rel="noopener noreferrer">
                          {prettyHost(href)}
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {failed.length ? (
        <p className="colophon-note">
          {failed.length} source{failed.length === 1 ? "" : "s"} missed this
          press run
          {failed.length <= 3
            ? ` (${failed.map((s) => s.slug).join(", ")})`
            : ""}
          . The issue is built from what did return.
        </p>
      ) : null}
    </article>
  );
}

function Feature({ theme, index }: { theme: ThemeView; index: number }) {
  const photo = leadPhoto(theme.items);
  return (
    <article className="feature" id={theme.id}>
      <h3 className="hed">Cover story</h3>
      {photo?.imageUrl ? (
        <figure className="lead-fig">
          <img src={photo.imageUrl} alt="" referrerPolicy="no-referrer" />
        </figure>
      ) : null}
      <p className="story-kicker">
        <span className="num">{pad(index + 1)}</span>
        {theme.isNew ? "New today" : "Ongoing"}
        {theme.continuedFrom
          ? ` · continued from ${shortDate(theme.continuedFrom.date)}`
          : ""}
      </p>
      <h2>{theme.name}</h2>
      {theme.desks.length ? (
        <p className="desks">{theme.desks.join(" · ")}</p>
      ) : null}
      <p className="standfirst">{theme.summary}</p>
      {theme.soWhat ? <p className="pull">{theme.soWhat}</p> : null}
      <Further items={theme.items} />
    </article>
  );
}

function Piece({ theme, index }: { theme: ThemeView; index: number }) {
  return (
    <article className="piece" id={theme.id}>
      <p className="story-kicker">
        <span className="num">{pad(index + 1)}</span>
        {theme.isNew ? "New today" : "Ongoing"}
        {theme.continuedFrom
          ? ` · continued from ${shortDate(theme.continuedFrom.date)}`
          : ""}
      </p>
      <h3 className="piece-hed">{theme.name}</h3>
      {theme.desks.length ? (
        <p className="desks">{theme.desks.join(" · ")}</p>
      ) : null}
      <p className="body">{theme.summary}</p>
      {theme.soWhat ? <p className="pull">{theme.soWhat}</p> : null}
      <Further items={theme.items} />
    </article>
  );
}

function Further({ items }: { items: DigestItemView[] }) {
  if (!items.length) return null;
  return (
    <ul className="further">
      {items.map((item) => (
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
          <cite>{item.sourceName}</cite>
        </li>
      ))}
    </ul>
  );
}

function prettyHost(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    const path = u.pathname === "/" ? "" : u.pathname;
    const shown = `${host}${path}`.slice(0, 72);
    return shown === `${host}${path}` ? shown : `${shown}…`;
  } catch {
    return url.slice(0, 72);
  }
}
