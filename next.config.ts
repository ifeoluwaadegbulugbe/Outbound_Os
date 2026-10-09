import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // PGlite ships WASM + data files that must be loaded from node_modules at
  // runtime, and postgres.js uses Node sockets — keep both out of the bundle.
  serverExternalPackages: ["@electric-sql/pglite", "postgres"],
  turbopack: { root: path.resolve(import.meta.dirname) },
  devIndicators: false,
  poweredByHeader: false,
  // Migrations are read at runtime (AUTO_MIGRATE / first boot).
  outputFileTracingIncludes: { "/**": ["./db/migrations/*.sql"] },
};

export default nextConfig;
