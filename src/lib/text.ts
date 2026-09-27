/**
 * Feeds hand us HTML-escaped text — `don&#x27;t`, `Apple&#8217;s`, `Q&amp;A` —
 * and some of it is escaped twice. Printed, that shows up as literal
 * ampersand-hash noise in the middle of a sentence.
 */
const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  hellip: "…", mdash: "—", ndash: "–",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
};

function once(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return String.fromCodePoint(cp);
      } catch {
        return m;
      }
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

export function decodeEntities(s: string): string {
  let out = s;
  // Twice: `&amp;#x27;` is an escaped escape and needs a second pass.
  for (let i = 0; i < 2; i++) {
    const next = once(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Comment bodies and feed descriptions arrive as HTML fragments — `<p>`,
 * `<a href="…">` — not text. Set in a newspaper column that is a wall of angle
 * brackets. Paragraph and line breaks become spaces, every other tag goes, and
 * entities are decoded on both sides of the strip, since a feed may escape its
 * markup (`&lt;p&gt;`) as well as its punctuation.
 */
export function plainText(s: string): string {
  const strip = (x: string) =>
    x
      .replace(/<\s*\/?\s*(?:p|br|div|li|pre|code)\b[^>]*>/gi, " ")
      .replace(/<[^>]*>/g, "");
  return strip(decodeEntities(strip(decodeEntities(s)))).replace(/\s+/g, " ").trim();
}
