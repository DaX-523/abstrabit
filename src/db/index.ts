import "server-only";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import * as schema from "./schema";

/**
 * DATABASE_URL is read directly from process.env (not env.ts) so this module
 * only needs the one variable it actually uses -- integration tests can set
 * just DATABASE_URL=pglite://... without validating the whole app's env.
 *
 * Two backends:
 *  - postgres://... (or postgresql://...) -> real Postgres via postgres.js.
 *    Used against Supabase in dev/prod. `prepare: false` because Supabase's
 *    transaction pooler (pgbouncer, port 6543) doesn't support prepared
 *    statements.
 *  - pglite://<path-or-empty-for-memory> -> an embedded Postgres (WASM) via
 *    PGlite. Used for local dev without a real DB and for integration tests,
 *    so `FOR UPDATE SKIP LOCKED`, jsonb, ON CONFLICT etc. all behave exactly
 *    as they will in production.
 *
 * Both drivers implement the same drizzle-orm/pg-core query builder surface
 * (select/insert/update/delete/transaction/execute). This module type-checks
 * everything against the postgres-js return type and casts the pglite branch
 * to match; the app never depends on driver-specific extras beyond that
 * shared surface, so the cast doesn't paper over a real incompatibility.
 */

export type Database = ReturnType<typeof drizzlePg<typeof schema>>;

function createDatabase(url: string): Database {
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Use a postgres:// URL, or pglite://./.data/dev for local dev.",
    );
  }

  if (url.startsWith("pglite://")) {
    const dataDir = url.slice("pglite://".length);
    const client = new PGlite(dataDir.length > 0 ? dataDir : undefined);
    return drizzlePglite(client, { schema }) as unknown as Database;
  }

  const client = postgres(url, { prepare: false });
  return drizzlePg(client, { schema });
}

let cached: Database | undefined;

/** Lazily created, cached singleton. Call this instead of connecting at import time. */
export function getDb(): Database {
  if (!cached) cached = createDatabase(process.env.DATABASE_URL ?? "");
  return cached;
}

export * as schema from "./schema";
