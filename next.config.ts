import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite is only used by the local verification harness (scripts/run-local.ts).
  // Keep it out of the server bundle so production deploys stay lean.
  serverExternalPackages: ["@electric-sql/pglite", "postgres"],
};

export default nextConfig;
