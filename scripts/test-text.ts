/**
 * HTML-entity decoding for printed text. Found in the first print proof:
 * "which don&#x27;t let me decide" and "Apple&#8217;s" set in a newspaper.
 *
 *   npx tsx scripts/test-text.ts
 */
import { decodeEntities, plainText } from "../src/lib/text";

let failed = 0;
function check(label: string, ok: boolean) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failed++;
}

check("hex apostrophe", decodeEntities("don&#x27;t") === "don't");
check("decimal right quote", decodeEntities("Apple&#8217;s") === "Apple’s");
check("named ampersand", decodeEntities("Q&amp;A") === "Q&A");
check("double-escaped apostrophe", decodeEntities("it&amp;#x27;s") === "it's");
check("named quote and dash", decodeEntities("&quot;a&quot; &mdash; b") === '"a" — b');
check("plain text is untouched", decodeEntities("no entities here") === "no entities here");
check("an unknown entity is left alone", decodeEntities("&notreal;") === "&notreal;");
check("a bare ampersand is left alone", decodeEntities("AT&T and R&D") === "AT&T and R&D");
check("an out-of-range codepoint is left alone", decodeEntities("&#99999999;") === "&#99999999;");

check("paragraph tags become spaces", plainText("<p>one</p><p>two</p>") === "one two");
check("an anchor keeps its text and loses its markup", plainText('see <a href="https://x.y/z" rel="nofollow">this page</a> now') === "see this page now");
check("escaped markup is stripped too", plainText("&lt;p&gt;hi &lt;a href=&quot;u&quot;&gt;there&lt;/a&gt;") === "hi there");
check("entities inside stripped text are decoded", plainText("<p>don&#x27;t</p>") === "don't");
check("code fences do not glue words together", plainText("a<pre><code>b</code></pre>c") === "a b c");

console.log(failed === 0 ? "\n✓ text verified\n" : `\n✗ ${failed} check(s) failed\n`);
process.exit(failed === 0 ? 0 : 1);
