import type { DigestItemView, DigestView, ThemeView } from "@/db/queries";
import { PrintButton } from "@/components/PrintButton";
import { decodeEntities, plainText } from "@/lib/text";

/**
 * The broadsheet: the same issue laid out to be printed, six Letter pages.
 *
 *   1  Front page      nameplate, lead story, what's inside
 *   2  The day         the remaining stories
 *   3-4 The wire       the day's intake, by desk, in small type
 *   5  Papers          new on arXiv
 *   6  Back page       appointments, noted, and how the issue was made
 *
 * Sections break to a new page; within a section text flows down four columns
 * and on to the next page if it runs long, so nothing is ever clipped — a
 * heavy day makes a longer paper rather than a silently truncated one. The
 * caps below are what keep an ordinary day at six.
 */

const LONG_DATE = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});

function longDate(dateKey: string): string {
  return LONG_DATE.format(new Date(`${dateKey}T12:00:00Z`));
}

function excerpt(text: string, max: number): string {
  const t = plainText(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max * 0.6))}…`;
}

function host(url: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/* ---------------------------------------------------------------- budgets */

/*
 * Pages are packed from an estimate of how tall each piece will set, so a page
 * is full without spilling a few lines onto an otherwise empty one. Measured
 * against Chrome's print output: a column is ~127pt wide and ~660pt tall under a
 * section band, four to a page. The estimate is deliberately a little
 * pessimistic (FILL) because the failure that matters is overflow, not a short
 * last column — and overflow still degrades gracefully, because sections flow
 * onto a following page rather than being clipped.
 */
const PAGE_COL_PT = 660;
const PAGE_PT = PAGE_COL_PT * 4;
const FILL = 0.86;
/** Story pages set in fewer, taller pieces; they can be packed a little tighter. */
const STORY_FILL = 0.95;

const PER_DESK = 14;
const PAPERS_MAX = 14;

const lines = (text: string, cpl: number) => Math.max(1, Math.ceil(text.length / cpl));

type Card = {
  key: string;
  kick: string;
  title: string;
  body: string | null;
  sowhat: string | null;
  meta: string | null;
  src: Array<{ text: string; by: string }>;
};

function cardHeight(c: Card, lead = false): number {
  let h = 9 + lines(c.title, lead ? 12 : 16) * (lead ? 20.5 : 13.6) + 4;
  if (c.body) h += lines(c.body, 30) * 11 + 4;
  if (c.sowhat) h += lines(c.sowhat, 28) * 10.9 + 4;
  if (c.meta) h += lines(c.meta, 32) * 7.8 + 3;
  for (const s of c.src) h += lines(`${s.text} — ${s.by}`, 33) * 8.8 + 2;
  return h + 9;
}

/** Cards, in order, until the budget (in column-points) is spent. */
function fit(cards: Card[], budget: number): { taken: Card[]; rest: Card[] } {
  let used = 0;
  let n = 0;
  for (const c of cards) {
    const h = cardHeight(c);
    if (used + h > budget) break;
    used += h;
    n += 1;
  }
  return { taken: cards.slice(0, n), rest: cards.slice(n) };
}

function briefHeight(i: DigestItemView): number {
  const text = `${excerpt(i.title, 120)}${i.score != null ? ` ▲${i.score}` : ""} ${host(i.url)}`;
  return lines(text, 33) * 9.1 + 2.6;
}

const isComment = (i: DigestItemView) => /comments/i.test(i.sourceName);
const isPaper = (i: DigestItemView) => /arxiv/i.test(i.sourceName);

type Desk = { name: string; items: DigestItemView[] };

/**
 * Wire briefs by desk, loudest desk first, trimmed to `budget`. Trimming takes
 * from the tail of whichever desk is currently longest, so no desk vanishes.
 */
function deskList(pool: DigestItemView[], budget: number): Desk[] {
  const byDesk = new Map<string, DigestItemView[]>();
  for (const item of pool) {
    const list = byDesk.get(item.sourceName) ?? [];
    list.push(item);
    byDesk.set(item.sourceName, list);
  }
  const desks: Desk[] = [...byDesk].map(([name, items]) => ({
    name,
    items: [...items]
      .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
      .slice(0, PER_DESK),
  }));
  const peak = (d: Desk) => Math.max(...d.items.map((i) => i.score ?? 0));
  desks.sort((a, b) => peak(b) - peak(a) || b.items.length - a.items.length);

  const height = () =>
    desks.reduce((n, d) => n + 26 + d.items.reduce((m, i) => m + briefHeight(i), 0), 0);
  while (desks.length && height() > budget) {
    const fattest = desks.reduce((a, b) => (b.items.length > a.items.length ? b : a));
    fattest.items.pop();
    if (!fattest.items.length) desks.splice(desks.indexOf(fattest), 1);
  }
  return desks;
}

function Card({ card, lead = false }: { card: Card; lead?: boolean }) {
  return (
    <article className={lead ? "lead" : "story"}>
      <p className="kick">{card.kick}</p>
      <h3>{decodeEntities(card.title)}</h3>
      {card.body ? <p className={lead ? "body drop" : "body"}>{decodeEntities(card.body)}</p> : null}
      {card.sowhat ? <p className="sowhat">{decodeEntities(card.sowhat)}</p> : null}
      {card.meta ? <p className="desks">{card.meta}</p> : null}
      {card.src.length ? (
        <ul className="src">
          {card.src.map((x) => (
            <li key={x.text}>
              {decodeEntities(x.text)}
              <span> — {x.by}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

function Band({ title, date, edition }: { title: string; date: string; edition: string }) {
  return (
    <h2 className="section-flag">
      <span>{title}</span>
      <small>
        Trendwire · {date} · {edition}
      </small>
    </h2>
  );
}

export function PrintEdition({
  digest,
  intake,
}: {
  digest: DigestView;
  intake: DigestItemView[];
}) {
  const wire = digest.edition === "wire";
  const date = longDate(digest.date);
  const edition = wire ? "Wire edition" : "Morning edition";
  const desksOk = digest.sourceHealth.filter((s) => s.status === "ok").length;

  const byId = new Map(intake.map((i) => [i.id, i]));
  const themeItemIds = new Set(digest.themes.flatMap((t) => t.items.map((i) => i.id)));

  /* ---- story cards: the issue's own stories, then the wire's best reading */
  const themeCards: Card[] = digest.themes.map((t, i) => {
    const first = t.items[0] ? byId.get(t.items[0].id) : undefined;
    const n = String(i + 1).padStart(2, "0");
    if (wire) {
      const it = t.items[0];
      return {
        key: t.id,
        kick: n,
        title: t.name,
        body: first?.excerpt ? excerpt(first.excerpt, 260) : null,
        sowhat: null,
        meta: it ? `${it.sourceName}${it.score != null ? ` · ▲${it.score}` : ""}` : null,
        src: [],
      };
    }
    return {
      key: t.id,
      kick: `${n}${t.isNew ? " · New today" : " · Ongoing"}`,
      title: t.name,
      body: t.summary,
      sowhat: t.soWhat,
      meta: t.desks.join(" · ") || null,
      src: t.items.slice(0, 3).map((x) => ({ text: excerpt(x.title, 100), by: x.sourceName })),
    };
  });

  const pool = intake.filter((i) => !themeItemIds.has(i.id) && !isComment(i) && !isPaper(i));
  const extraCards: Card[] = pool
    .filter((i) => (i.excerpt?.length ?? 0) >= 90)
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
    .slice(0, 24)
    .map((i) => ({
      key: `x-${i.id}`,
      kick: "From the wire",
      title: excerpt(i.title, 110),
      body: excerpt(i.excerpt ?? "", 240),
      sowhat: null,
      meta: `${i.sourceName}${i.score != null ? ` · ▲${i.score}` : ""}`,
      src: [],
    }));
  const extraIds = new Set(extraCards.map((c) => c.key.slice(2)));

  /* ---- page 1: what fits beside the masthead, the day note and the index */
  const [leadCard, ...restCards] = themeCards;
  const dayNote = wire
    ? "The editors did not file today. What follows is the day’s intake, ranked by the desks it came from — not clustered into stories."
    : digest.intro;
  // Under the nameplate and headline (~178pt of a 720pt page) — not under a band.
const FRONT_BUDGET = 4 * (720 - 178) * STORY_FILL;
  const fixedFront =
    (dayNote ? 42 + lines(dayNote, 32) * 11 : 0) + (leadCard ? cardHeight(leadCard, true) : 0) + 118;
  // The front draws on the wire's best reading too: an issue may only have the
  // eight stories a wire edition carries, and eight do not fill a front page.
  const front = fit([...restCards, ...extraCards], Math.max(0, FRONT_BUDGET - fixedFront));

  /* ---- page 2: the rest of the stories, then the wire's best reading */
  const page2 = fit(front.rest, (PAGE_PT - 50) * STORY_FILL);

  /* ---- pages 3-4: everything else, by desk */
  const shown = new Set([...front.taken, ...page2.taken].map((c) => c.key.replace(/^x-/, "")));
  const wirePool = pool.filter((i) => !extraIds.has(i.id) || !shown.has(i.id));
  const wireBudget = (PAGE_PT - 60) * FILL;
  const oneDesks = deskList(wirePool, wireBudget);
  const twoDesks = deskList(wirePool, wireBudget * 2 - 50);
  // A section that would run only a little onto a second page stays on one:
  // a mostly blank page 4 is worse than a tighter page 3.
  const twoHeight = twoDesks.reduce(
    (n, d) => n + 26 + d.items.reduce((m, i) => m + briefHeight(i), 0),
    0,
  );
  const desks = twoHeight > wireBudget * 1.45 ? twoDesks : oneDesks;
  const wirePages = desks === twoDesks ? "3–4" : "3";
  const wireCount = desks.reduce((n, d) => n + d.items.length, 0);

  /* ---- papers, and what the back page can still hold */
  const papers = (digest.papers ?? []).slice(0, PAPERS_MAX);
  const paperIds = new Set(papers.map((p) => p.id));
  // The back page is packed by measured height like the others: fixed blocks
  // first, then Overheard up to about half of what is left, then arXiv titles.
  const oh = (c: DigestItemView) =>
    lines(`“${excerpt(c.excerpt ?? "", 300)}” — ${c.author ?? ""}, on ${excerpt(c.title, 70)}`, 34) * 10.3 + 4;
  const ax = (p: DigestItemView) =>
    lines(`${excerpt(p.title, 95)} — ${excerpt(p.author ?? "", 40)}`, 33) * 8.8 + 2;
  const fixedBack =
    30 + Math.max(1, digest.people.length) * 46 + digest.bookmarks.length * 60 + 150 +
    digest.sourceHealth.length * 13.6 + 34;
  let spare = (PAGE_PT - 60) * 0.88 - fixedBack;
  const overheardAll = intake.filter((i) => isComment(i) && (i.excerpt?.length ?? 0) > 120);
  const overheard: DigestItemView[] = [];
  let ohUsed = 0;
  for (const c of overheardAll) {
    const h = oh(c);
    if (ohUsed + h > spare * 0.55) break;
    overheard.push(c);
    ohUsed += h;
  }
  spare -= ohUsed;
  const morePapers: DigestItemView[] = [];
  for (const p of intake.filter((i) => isPaper(i) && !paperIds.has(i.id))) {
    const h = ax(p);
    if (h > spare) break;
    morePapers.push(p);
    spare -= h;
  }

  const backPage = desks === twoDesks ? "6" : "5";
  const papersPage = desks === twoDesks ? "5" : "4";

  return (
    <div className="broadsheet">
      <div className="toolbar" data-noprint>
        <PrintButton />
        <span>
          Letter paper, portrait. In the print dialog turn off “Headers and
          footers” and turn on “Background graphics”.
        </span>
        <a href={`/digest/${digest.date}`}>← Back to the issue</a>
      </div>

      {/* ------------------------------------------------------------ page 1 */}
      <section className="leaf front">
        <header className="nameplate">
          <p className="ear">
            <span>The day’s argument, without the sites</span>
            <span>Typeset daily from the open web</span>
          </p>
          <h1>Trendwire</h1>
          <p className="dateline">
            <span>{date}</span>
            <span>{edition}</span>
            <span>
              {digest.itemCount} items read · {desksOk} desks reporting
            </span>
          </p>
        </header>

        <h2 className="banner-hed">{decodeEntities(digest.headline ?? "No single story dominated.")}</h2>

        <div className="cols">
          {dayNote ? (
            <div className="day">
              <p className="flag">The day</p>
              <p className="lede">{dayNote}</p>
            </div>
          ) : null}
          {leadCard ? (
            <Card card={{ ...leadCard, kick: wire ? "Top of the wire" : "Cover story" }} lead />
          ) : null}
          {front.taken.map((c) => (
            <Card key={c.key} card={c} />
          ))}
          <aside className="inside">
            <p className="flag">Inside</p>
            <dl>
              <dt>Page 2</dt>
              <dd>More of the day’s reading</dd>
              <dt>Page {wirePages}</dt>
              <dd>The Wire — {wireCount} items from {desks.length} desks</dd>
              <dt>Page {papersPage}</dt>
              <dd>Papers — new from arXiv</dd>
              <dt>Page {backPage}</dt>
              <dd>Overheard, appointments, and how this was made</dd>
            </dl>
          </aside>
        </div>
      </section>

      {/* ------------------------------------------------------------ page 2 */}
      <section className="leaf">
        <Band title="The day’s reading" date={date} edition={edition} />
        <div className="cols">
          {page2.taken.length ? (
            page2.taken.map((c) => <Card key={c.key} card={c} />)
          ) : (
            <p className="quiet">The rest of the day’s reading is on the wire, overleaf.</p>
          )}
        </div>
      </section>

      {/* ------------------------------------------------------------- wire */}
      <section className="leaf">
        <Band title="The Wire" date={date} edition={edition} />
        <p className="section-note">
          Everything else the desks carried, loudest first. ▲ is the score at the
          time of the press run.
        </p>
        <div className="cols tight">
          {desks.map((d) => (
            <div className="desk-block" key={d.name}>
              <h3 className="desk-name">{d.name}</h3>
              <ul className="briefs">
                {d.items.map((i) => (
                  <li key={i.id}>
                    <span className="t">{excerpt(i.title, 120)}</span>
                    {i.score != null ? <span className="s"> ▲{i.score}</span> : null}
                    {host(i.url) ? <span className="h"> {host(i.url)}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {/* ----------------------------------------------------------- papers */}
      <section className="leaf">
        <Band title="Papers" date={date} edition={edition} />
        <p className="section-note">
          New on arXiv in cs.AI, cs.LG and cs.CL since the last issue.
        </p>
        <div className="cols">
          {papers.length ? (
            papers.map((p) => (
              <article className="paper" key={p.id}>
                <h3>{decodeEntities(p.title)}</h3>
                {p.authors ? <p className="by">{decodeEntities(p.authors)}</p> : null}
                {p.abstract ? <p className="body">{excerpt(p.abstract, 330)}</p> : null}
              </article>
            ))
          ) : (
            <p className="quiet">No new papers were collected for this issue.</p>
          )}
        </div>
      </section>

      {/* ------------------------------------------------------- back page */}
      <section className="leaf">
        <Band title="Overheard & colophon" date={date} edition={edition} />
        <div className="cols">
          <div className="block">
            <p className="flag">Appointments</p>
            {digest.people.length ? (
              digest.people.map((m) => (
                <p className="move" key={m.id}>
                  <b>{m.person}</b> — {m.moveType.replace("_", " ")}
                  {m.fromOrg ? ` from ${m.fromOrg}` : ""}
                  {m.toOrg ? ` to ${m.toOrg}` : ""}
                  {m.role ? `, ${m.role}` : ""} <i>({m.confidence})</i>
                  {m.note ? ` ${m.note}` : ""}
                </p>
              ))
            ) : (
              <p className="quiet">
                No confirmed moves in today’s reading.
                {wire ? " The people beat needs the editors’ desk, which did not file." : ""}
              </p>
            )}
          </div>

          {digest.bookmarks.length ? (
            <div className="block">
              <p className="flag">Noted</p>
              {digest.bookmarks.map((b) => (
                <p className="move" key={b.tweetId}>
                  <b>{b.author ? `@${b.author}` : "Saved"}</b>{" "}
                  {b.text ? excerpt(b.text, 240) : ""}
                </p>
              ))}
            </div>
          ) : null}

          {overheard.length ? (
            <div className="stream">
              <p className="flag">Overheard on Hacker News</p>
              {overheard.map((c) => (
                <p className="move overheard" key={c.id}>
                  “{excerpt(c.excerpt ?? "", 300)}”
                  <span>
                    {" "}
                    — {c.author ? `${c.author}, ` : ""}on {excerpt(c.title, 70)}
                  </span>
                </p>
              ))}
            </div>
          ) : null}

          {morePapers.length ? (
            <div className="stream">
              <p className="flag">Also on arXiv</p>
              <ul className="src">
                {morePapers.map((p) => (
                  <li key={p.id}>
                    {excerpt(p.title, 95)}
                    {p.author ? <span> — {excerpt(p.author, 40)}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="block">
            <p className="flag">How this was made</p>
            <p className="body">
              Trendwire reads {digest.sourceHealth.length} desks — Hacker News,
              Lobsters, GitHub, Techmeme, arXiv, the trade press and a handful of
              newsletters — once a day, removes duplicates across them, and sets
              the result in type. {digest.itemCount} items were read for this issue.
              {wire
                ? " The editorial pass did not run, so this is a wire edition: the reading, ranked, without a written argument."
                : ""}
            </p>
          </div>

          <div className="block">
            <p className="flag">The desks</p>
            <ul className="health">
              {digest.sourceHealth.map((s) => (
                <li key={s.slug} className={s.status}>
                  <span>{s.slug}</span>
                  <span>{s.status === "ok" ? s.itemsFound : s.status}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}
