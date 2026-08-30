/** Absolute base URL — needed because the worker re-invokes itself by HTTP. */
export function baseUrl(): string {
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
  }
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return "http://localhost:3000";
}

/** Constant-time-ish bearer check for cron and worker routes. */
export function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  // No secret configured: allow only outside production, so a misconfigured
  // deploy fails closed rather than exposing the pipeline.
  if (!secret) return process.env.NODE_ENV !== "production";

  const header = req.headers.get("authorization") ?? "";
  return secretsEqual(header, `Bearer ${secret}`);
}

/**
 * Bookmark capture auth. Prefers BOOKMARK_SECRET so a leaked bookmarklet
 * cannot fire the digest pipeline. Falls back to CRON_SECRET.
 */
export function authorizedBookmark(req: Request, url?: URL): boolean {
  const secret = process.env.BOOKMARK_SECRET || process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production";

  const token =
    url?.searchParams.get("token") ??
    req.headers.get("x-bookmark-token") ??
    "";
  if (token && secretsEqual(token, secret)) return true;

  const header = req.headers.get("authorization") ?? "";
  return secretsEqual(header, `Bearer ${secret}`);
}

function secretsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
