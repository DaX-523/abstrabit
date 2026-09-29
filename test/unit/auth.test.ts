import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const cookieStore = new Map<string, { value: string }>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => cookieStore.get(name),
    set: (name: string, value: string) => {
      cookieStore.set(name, { value });
    },
    delete: (name: string) => {
      cookieStore.delete(name);
    },
    has: (name: string) => cookieStore.has(name),
  }),
}));

import { createTestDb } from "../helpers/testDb";
import type { Database } from "@/db";
import {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  getUserForSession,
  pruneExpiredSessions,
  setSessionCookie,
  clearSessionCookie,
  getCurrentUser,
  requireUser,
  requireGuildAdmin,
  AuthError,
} from "@/lib/auth";
import { schema } from "@/db";

describe("hashPassword / verifyPassword", () => {
  it("round-trips a correct password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("wrong password", hash)).toBe(false);
  });

  it("produces a different hash each time (random salt)", async () => {
    const a = await hashPassword("same password");
    const b = await hashPassword("same password");
    expect(a).not.toBe(b);
  });

  it("returns false rather than throwing for a malformed stored hash", async () => {
    await expect(verifyPassword("anything", "not-a-valid-hash")).resolves.toBe(false);
  });
});

describe("sessions + cookie-backed current-user lookup", () => {
  let db: Database;
  let close: () => Promise<void>;
  let userId: string;

  beforeEach(async () => {
    cookieStore.clear();
    ({ db, close } = await createTestDb());
    const [user] = await db
      .insert(schema.users)
      .values({ email: "admin@example.com", passwordHash: "irrelevant" })
      .returning();
    userId = user.id;
  });

  afterEach(() => close());

  it("creates a session and resolves the user from its cookie", async () => {
    const token = await createSession(db, userId);
    await setSessionCookie(token);
    const user = await getCurrentUser(db);
    expect(user?.id).toBe(userId);
  });

  it("only stores a hash of the token, not the token itself", async () => {
    const token = await createSession(db, userId);
    const row = await db.query.sessions.findFirst({ where: (s, { eq }) => eq(s.userId, userId) });
    expect(row?.tokenHash).not.toBe(token);
    expect(row?.tokenHash).toHaveLength(64); // sha256 hex
  });

  it("returns null for a token that was never issued", async () => {
    expect(await getUserForSession(db, "not-a-real-token")).toBeNull();
  });

  it("returns null (not the user) once the session is destroyed", async () => {
    const token = await createSession(db, userId);
    await destroySession(db, token);
    expect(await getUserForSession(db, token)).toBeNull();
  });

  it("returns null with no cookie set at all", async () => {
    expect(await getCurrentUser(db)).toBeNull();
  });

  it("clearSessionCookie removes the cookie so getCurrentUser sees no session", async () => {
    const token = await createSession(db, userId);
    await setSessionCookie(token);
    await clearSessionCookie();
    expect(await getCurrentUser(db)).toBeNull();
  });

  it("prunes expired sessions", async () => {
    await db.insert(schema.sessions).values({
      tokenHash: "expired-hash",
      userId,
      expiresAt: new Date(Date.now() - 1000),
    });
    await pruneExpiredSessions(db);
    const row = await db.query.sessions.findFirst({ where: (s, { eq }) => eq(s.tokenHash, "expired-hash") });
    expect(row).toBeUndefined();
  });

  it("requireUser throws AuthError when no session is present", async () => {
    await expect(requireUser(db)).rejects.toBeInstanceOf(AuthError);
  });

  it("requireUser resolves when a valid session is present", async () => {
    const token = await createSession(db, userId);
    await setSessionCookie(token);
    await expect(requireUser(db)).resolves.toMatchObject({ id: userId });
  });

  it("requireGuildAdmin throws for a user who isn't an admin of that guild", async () => {
    const token = await createSession(db, userId);
    await setSessionCookie(token);
    await db.insert(schema.guilds).values({ id: "guild-1", name: "G" });
    await expect(requireGuildAdmin(db, "guild-1")).rejects.toBeInstanceOf(AuthError);
  });

  it("requireGuildAdmin resolves for a user who is an admin of that guild", async () => {
    const token = await createSession(db, userId);
    await setSessionCookie(token);
    await db.insert(schema.guilds).values({ id: "guild-2", name: "G2" });
    await db.insert(schema.guildAdmins).values({ guildId: "guild-2", userId });
    await expect(requireGuildAdmin(db, "guild-2")).resolves.toMatchObject({ id: userId });
  });

  it("requireGuildAdmin does not let an admin of guild A act on guild B", async () => {
    const token = await createSession(db, userId);
    await setSessionCookie(token);
    await db.insert(schema.guilds).values([{ id: "guild-a", name: "A" }, { id: "guild-b", name: "B" }]);
    await db.insert(schema.guildAdmins).values({ guildId: "guild-a", userId });
    await expect(requireGuildAdmin(db, "guild-b")).rejects.toBeInstanceOf(AuthError);
  });
});
