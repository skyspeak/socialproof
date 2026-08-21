import { getDigest, getDigestDates } from "@/db/queries";
import { baseUrl } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function GET() {
  const site = baseUrl();
  const dates = await getDigestDates(20).catch(() => []);
  const published = dates.filter((d) => d.status === "published").slice(0, 15);

  const entries = await Promise.all(
    published.map(async (d) => {
      const digest = await getDigest(d.date).catch(() => null);
      if (!digest) return "";

      const body = [
        digest.intro ?? "",
        ...digest.themes.map(
          (t) =>
            `<h3>${escapeXml(t.name)}</h3><p>${escapeXml(t.summary)}</p>${
              t.soWhat ? `<p><em>${escapeXml(t.soWhat)}</em></p>` : ""
            }`,
        ),
        digest.people.length
          ? `<h3>People moves</h3><ul>${digest.people
              .map(
                (p) =>
                  `<li>${escapeXml(p.person)}${p.fromOrg ? ` — from ${escapeXml(p.fromOrg)}` : ""}${
                    p.toOrg ? ` → ${escapeXml(p.toOrg)}` : ""
                  } (${escapeXml(p.confidence)})</li>`,
              )
              .join("")}</ul>`
          : "",
      ].join("");

      return `    <item>
      <title>${escapeXml(digest.headline ?? `Trendwire — ${d.date}`)}</title>
      <link>${site}/digest/${d.date}</link>
      <guid isPermaLink="true">${site}/digest/${d.date}</guid>
      <pubDate>${new Date(`${d.date}T13:00:00Z`).toUTCString()}</pubDate>
      <description><![CDATA[${body}]]></description>
    </item>`;
    }),
  );

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Trendwire</title>
    <link>${site}</link>
    <description>The daily technology read, assembled without opening X.</description>
    <language>en</language>
${entries.filter(Boolean).join("\n")}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": "public, s-maxage=1800",
    },
  });
}
