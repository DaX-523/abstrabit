import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Pin the workspace root explicitly: there's an unrelated package-lock.json
  // in the parent (home) directory that would otherwise make Turbopack guess
  // the wrong root.
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
