"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getDb, schema } from "@/db";
import { getEnv } from "@/lib/env";
import { log } from "@/lib/log";
import {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  pruneExpiredSessions,
  getCurrentUser,
  getSessionToken,
} from "@/lib/auth";
import { recordLoginAttempt, isLoginThrottled } from "@/lib/loginThrottle";

async function clientIp(): Promise<string> {
  const h = await headers();
  // Vercel sets x-forwarded-for; fall back to a constant so local dev
  // (no proxy in front) still throttles per-email rather than crashing.
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
}

function redirectWithError(path: string, message: string): never {
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

export async function loginAction(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const db = getDb();
  const ip = await clientIp();

  if (!email || !password) {
    redirectWithError("/login", "Email and password are required.");
  }

  if (await isLoginThrottled(db, { email, ip })) {
    redirectWithError("/login", "Too many attempts. Please wait a few minutes and try again.");
  }

  const user = await db.query.users.findFirst({
    where: (u, { sql: s }) => s`lower(${u.email}) = lower(${email})`,
  });

  const ok = user ? await verifyPassword(password, user.passwordHash) : false;
  await recordLoginAttempt(db, { email, ip, succeeded: ok });

  if (!ok || !user) {
    redirectWithError("/login", "Invalid email or password.");
  }

  await pruneExpiredSessions(db);
  const token = await createSession(db, user.id);
  await setSessionCookie(token);
  log.info("user signed in", { userId: user.id });
  redirect("/dashboard");
}

export async function signupAction(formData: FormData): Promise<void> {
  const env = getEnv();
  if (!env.ALLOW_SIGNUP) {
    redirectWithError("/signup", "Signup is currently disabled.");
  }

  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirmPassword") ?? "");

  if (!email || !password) {
    redirectWithError("/signup", "Email and password are required.");
  }
  if (password.length < 8) {
    redirectWithError("/signup", "Password must be at least 8 characters.");
  }
  if (password !== confirm) {
    redirectWithError("/signup", "Passwords don't match.");
  }

  const db = getDb();
  const existing = await db.query.users.findFirst({
    where: (u, { sql: s }) => s`lower(${u.email}) = lower(${email})`,
  });
  if (existing) {
    redirectWithError("/signup", "An account with that email already exists.");
  }

  const passwordHash = await hashPassword(password);
  const [user] = await db.insert(schema.users).values({ email, passwordHash }).returning();
  const token = await createSession(db, user.id);
  await setSessionCookie(token);
  log.info("user signed up", { userId: user.id });
  redirect("/dashboard");
}

export async function logoutAction(): Promise<void> {
  const db = getDb();
  const user = await getCurrentUser(db);
  const token = await getSessionToken();
  if (token) await destroySession(db, token); // invalidate server-side, not just clear the cookie
  await clearSessionCookie();
  if (user) log.info("user signed out", { userId: user.id });
  redirect("/login");
}
