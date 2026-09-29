import "server-only";
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import { cookies } from "next/headers";
import { eq, lt } from "drizzle-orm";
import { schema, type Database } from "@/db";

const scrypt = promisify(scryptCallback);

export const SESSION_COOKIE_NAME = "session";
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SCRYPT_KEYLEN = 64;

// ---------------------------------------------------------------------------
// Password hashing (scrypt: no extra dependency, built into Node, and
// deliberately memory-hard -- suitable for a small admin user base).
// ---------------------------------------------------------------------------

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, SCRYPT_KEYLEN)) as Buffer;
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const derived = (await scrypt(password, salt, expected.length)) as Buffer;
  // timingSafeEqual throws if lengths differ, which they won't here since we
  // derive with expected.length -- but guard anyway for a malformed stored value.
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// ---------------------------------------------------------------------------
// Sessions: only the sha256 of the token is ever stored, so a DB read alone
// can't produce a usable cookie value.
// ---------------------------------------------------------------------------

export async function createSession(db: Database, userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);
  await db.insert(schema.sessions).values({ tokenHash: hashToken(token), userId, expiresAt });
  return token;
}

export async function destroySession(db: Database, token: string): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, hashToken(token)));
}

/** Opportunistic cleanup; cheap enough to call on every login. */
export async function pruneExpiredSessions(db: Database): Promise<void> {
  await db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, new Date()));
}

export interface SessionUser {
  id: string;
  email: string;
}

export async function getUserForSession(db: Database, token: string): Promise<SessionUser | null> {
  const session = await db.query.sessions.findFirst({
    where: (s, { eq }) => eq(s.tokenHash, hashToken(token)),
  });
  if (!session || session.expiresAt.getTime() < Date.now()) return null;

  const user = await db.query.users.findFirst({ where: (u, { eq }) => eq(u.id, session.userId) });
  return user ? { id: user.id, email: user.email } : null;
}

// ---------------------------------------------------------------------------
// Cookie + request-scoped helpers for use in server components/actions/routes
// ---------------------------------------------------------------------------

export async function setSessionCookie(token: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_LIFETIME_MS / 1000,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE_NAME);
}

export async function getSessionToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(SESSION_COOKIE_NAME)?.value ?? null;
}

/** Returns the signed-in user, or null. Never throws -- callers decide what "no user" means. */
export async function getCurrentUser(db: Database): Promise<SessionUser | null> {
  const token = await getSessionToken();
  if (!token) return null;
  return getUserForSession(db, token);
}

/**
 * Throws if there's no signed-in user. Every dashboard server component,
 * action, and API route that reads or changes anything must call this (or
 * requireGuildAdmin) itself -- proxy.ts only redirects unauthenticated page
 * loads for UX and must never be the sole gate, since middleware/proxy-only
 * auth is a well-known bypass class (route handlers and server actions can
 * be hit directly).
 */
export async function requireUser(db: Database): Promise<SessionUser> {
  const user = await getCurrentUser(db);
  if (!user) throw new AuthError("Not signed in");
  return user;
}

export async function requireGuildAdmin(db: Database, guildId: string): Promise<SessionUser> {
  const user = await requireUser(db);
  const membership = await db.query.guildAdmins.findFirst({
    where: (a, { and, eq }) => and(eq(a.guildId, guildId), eq(a.userId, user.id)),
  });
  if (!membership) throw new AuthError("Not an admin of this server");
  return user;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}
