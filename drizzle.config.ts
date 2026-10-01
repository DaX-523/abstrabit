import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// Like the scripts/, read .env.local; a DATABASE_URL already set in the shell wins.
config({ path: ".env.local" });

const url = process.env.DATABASE_URL ?? "postgres://placeholder/placeholder";

// Same two backends as src/db/index.ts: pglite://<dir> migrates the embedded
// local database (zero-install dev), anything else is a real Postgres URL.
export default defineConfig(
  url.startsWith("pglite://")
    ? {
        dialect: "postgresql",
        driver: "pglite",
        schema: "./src/db/schema.ts",
        out: "./drizzle",
        dbCredentials: { url: url.slice("pglite://".length) },
      }
    : {
        dialect: "postgresql",
        schema: "./src/db/schema.ts",
        out: "./drizzle",
        dbCredentials: { url },
      },
);
