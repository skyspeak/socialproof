/**
 * Date-key validation. `isValidDateKey` exists because the two date-keyed API
 * routes used to check digit-shape alone (`/^\d{4}-\d{2}-\d{2}$/`), which
 * accepts `2026-02-30` and `2026-13-45` as well-formed — both then reached a
 * Postgres `date` column comparison uncaught, surfacing as a bare 500 with no
 * body. Found live, on the actual deployment, by hand.
 *
 *   npx tsx scripts/test-window.ts
 */
import { isValidDateKey } from "../src/lib/window";

let failed = 0;
function check(label: string, ok: boolean) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failed++;
}

check("an ordinary date is valid", isValidDateKey("2026-09-22"));
check("the first of the year is valid", isValidDateKey("2026-01-01"));
check("the last of the year is valid", isValidDateKey("2026-12-31"));
check("Feb 29 in a leap year is valid", isValidDateKey("2024-02-29"));
check("Feb 29 in a non-leap year is invalid", !isValidDateKey("2026-02-29"));
check("Feb 30 is invalid", !isValidDateKey("2026-02-30"));
check("month 13 is invalid", !isValidDateKey("2026-13-45"));
check("month 00 is invalid", !isValidDateKey("2026-00-15"));
check("day 00 is invalid", !isValidDateKey("2026-09-00"));
check("day 32 is invalid", !isValidDateKey("2026-09-32"));
check("a non-digit-shaped string is invalid", !isValidDateKey("not-a-date"));
check("a short year is invalid", !isValidDateKey("26-09-22"));
check("an empty string is invalid", !isValidDateKey(""));
check("the literal 'latest' is invalid — routes check that separately", !isValidDateKey("latest"));

console.log(failed === 0 ? "\n✓ window verified\n" : `\n✗ ${failed} check(s) failed\n`);
process.exit(failed === 0 ? 0 : 1);
