import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Integration tests spin up a PGlite instance; give them room.
    testTimeout: 15_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // "server-only" is a build-time guard meant for Next's bundler (which
      // picks a no-op via package.json export conditions); under plain Node
      // it just throws. No-op it for tests.
      "server-only": path.resolve(__dirname, "./test/stubs/server-only.ts"),
    },
  },
});
