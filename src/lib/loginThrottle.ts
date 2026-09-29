import "server-only";
import { and, eq, gte, or, sql } from "drizzle-orm";
import { schema, type Database } from "@/db";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;

export async function recordLoginAttempt(
  db: Database,
  params: { email: string; ip: string; succeeded: boolean },
): Promise<void> {
  await db.insert(schema.loginAttempts).values({
    email: params.email.toLowerCase(),
    ip: params.ip,
    succeeded: params.succeeded,
  });
}

/** True if this email or this IP has racked up too many recent failures. */
export async function isLoginThrottled(db: Database, params: { email: string; ip: string }): Promise<boolean> {
  const since = new Date(Date.now() - WINDOW_MS);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.loginAttempts)
    .where(
      and(
        eq(schema.loginAttempts.succeeded, false),
        gte(schema.loginAttempts.createdAt, since),
        or(eq(schema.loginAttempts.email, params.email.toLowerCase()), eq(schema.loginAttempts.ip, params.ip)),
      ),
    );
  return (row?.count ?? 0) >= MAX_FAILED_ATTEMPTS;
}
