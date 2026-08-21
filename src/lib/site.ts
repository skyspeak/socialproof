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
  return header === `Bearer ${secret}`;
}
