import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

/**
 * Spins up a fresh, in-memory Postgres (via PGlite) with the real migrations
 * applied, for integration tests that need genuine Postgres semantics
 * (ON CONFLICT, FOR UPDATE SKIP LOCKED, jsonb) rather than a mock.
 *
 * Cast to `Database` (the postgres-js type) for the same reason src/db/index.ts
 * casts it: the app only touches the shared drizzle-orm/pg-core query-builder
 * surface, which both drivers implement identically.
 */
export async function createTestDb(): Promise<{ db: Database; close: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as PgliteDatabase<typeof schema>;
  await migrate(db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
  return {
    db: db as unknown as Database,
    close: () => client.close(),
  };
}
