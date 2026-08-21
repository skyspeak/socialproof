/**
 * Shared heuristics for the people beat.
 *
 * Keyword search alone is far too loose — a query for "founder" returns most
 * of the startup news on any given day. These patterns require the *shape* of
 * a personnel announcement, which cuts the noise dramatically before anything
 * reaches synthesis.
 */

const MOVE_SHAPES: RegExp[] = [
  /\b(?:is\s+)?leaving\s+[A-Z]/,
  /\b(?:has\s+)?resigned?\b/i,
  /\bsteps?\s+down\b/i,
  /\bstepping\s+down\b/i,
  /\bdeparts?\b/i,
  /\bdeparture\b/i,
  /\bjoins?\s+[A-Z]/,
  /\bjoining\s+[A-Z]/,
  /\bhired\s+(?:as|by)\b/i,
  /\bnamed\s+(?:new\s+)?(?:CEO|CTO|CFO|COO|president|chair|head\s+of|chief)/i,
  /\bappointed\b/i,
  /\bnew\s+(?:CEO|CTO|CFO|COO)\b/i,
  /\bousted\b/i,
  /\bfired\b/i,
  /\bsteps?\s+aside\b/i,
  /\bpromoted\s+to\b/i,
  /\btakes?\s+over\s+as\b/i,
  /\bresignation\b/i,
  /\bexits?\s+[A-Z]/,
  /\bresearcher[s]?\s+(?:leave|leaving|depart)/i,
  /\bpoach(?:ed|es|ing)\b/i,
  /\bresearch\s+lead\b/i,
  /\bco-?founder\s+(?:of\s+\w+\s+)?(?:leaves|leaving|departs|steps)/i,
  /\bafter\s+\d+\s+years\s+at\b/i,
  /\bstarting\s+(?:a\s+)?new\s+(?:company|lab|startup)/i,
  /\bout\s+of\s+stealth\b/i,
];

/** Titles that match personnel-announcement shape rather than mere keywords. */
export function looksLikePeopleMove(title: string): boolean {
  return MOVE_SHAPES.some((re) => re.test(title));
}

/** Obvious false positives from the shape patterns above. */
const EXCLUSIONS: RegExp[] = [
  /\bleaving\s+(?:home|the\s+house|comments?|reviews?)\b/i,
  /\bjoins?\s+(?:the\s+)?(?:list|club|chat|waitlist|beta)\b/i,
  /\bfired\s+(?:up|off)\b/i,
];

export function isPeopleMoveHeadline(title: string): boolean {
  if (!looksLikePeopleMove(title)) return false;
  return !EXCLUSIONS.some((re) => re.test(title));
}
