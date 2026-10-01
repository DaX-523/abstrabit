import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // PGlite (the embedded Postgres used for local dev without a database) loads
  // its WASM and data files relative to its own package, which breaks if the
  // bundler inlines it. Keep it as a plain node_modules import.
  serverExternalPackages: ["@electric-sql/pglite"],
  // Pin the workspace root explicitly: there's an unrelated package-lock.json
  // in the parent (home) directory that would otherwise make Turbopack guess
  // the wrong root.
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
