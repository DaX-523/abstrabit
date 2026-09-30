import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * Regression test for a real bug found in production: testChannelAction and
 * testMirrorAction called the success redirect() INSIDE the try block that
 * wraps the network call. Next's redirect() works by throwing a special
 * error to unwind rendering -- so that throw was being caught by the
 * function's own catch clause, and a genuinely successful send was reported
 * to the user as a failure. This test mocks redirect() to throw (mirroring
 * its real behavior) and asserts that a successful send results in exactly
 * one redirect, to the success URL -- not the error one.
 */

class FakeRedirectError extends Error {
  constructor(public url: string) {
    super("NEXT_REDIRECT");
  }
}

const redirectMock = vi.fn((url: string) => {
  throw new FakeRedirectError(url);
});

vi.mock("next/navigation", () => ({ redirect: redirectMock }));

const cookieStore = new Map<string, { value: string }>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => cookieStore.get(name),
    set: (name: string, value: string) => cookieStore.set(name, { value }),
    delete: (name: string) => cookieStore.delete(name),
    has: (name: string) => cookieStore.has(name),
  }),
}));

import { createTestDb } from "../helpers/testDb";
import { schema } from "@/db";
import type { Database } from "@/db";
import { createSession, setSessionCookie } from "@/lib/auth";
import { encrypt } from "@/lib/crypto";

let db: Database;
let close: () => Promise<void>;

vi.mock("@/db", async () => {
  const actual = await vi.importActual<typeof import("@/db")>("@/db");
  return { ...actual, getDb: () => db };
});

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");
  process.env.DISCORD_APPLICATION_ID = "app-id";
  process.env.DISCORD_PUBLIC_KEY = "a".repeat(64);
  process.env.DISCORD_BOT_TOKEN = "bot-token-value";
  process.env.DISCORD_CLIENT_SECRET = "client-secret";
  process.env.DISCORD_OAUTH_REDIRECT_URI = "http://localhost:3000/api/discord/oauth/callback";
  process.env.GROQ_API_KEY = "groq-key";
  process.env.CRON_SECRET = "a".repeat(20);
  process.env.SESSION_SECRET = "b".repeat(20);
  process.env.APP_BASE_URL = "http://localhost:3000";

  cookieStore.clear();
  redirectMock.mockClear();
  ({ db, close } = await createTestDb());

  const [user] = await db.insert(schema.users).values({ email: "admin@example.com", passwordHash: "x" }).returning();
  const token = await createSession(db, user.id);
  await setSessionCookie(token);

  await db.insert(schema.guilds).values({
    id: "guild-1",
    name: "G",
    reportChannelId: "chan-1",
    mirrorKind: "slack",
    mirrorUrlEnc: encrypt("https://hooks.slack.com/services/T0/B0/xyz"),
  });
  await db.insert(schema.guildAdmins).values({ guildId: "guild-1", userId: user.id });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.doUnmock("@/lib/discord/api");
  vi.doUnmock("@/lib/mirror");
  vi.resetModules();
  await close();
});

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe("testChannelAction", () => {
  it("redirects to success (not error) when the post actually succeeds", async () => {
    vi.doMock("@/lib/discord/api", () => ({ postChannelMessage: vi.fn().mockResolvedValue({ id: "msg-1" }) }));
    const { testChannelAction } = await import("@/app/dashboard/[guildId]/actions");

    await expect(testChannelAction(formData({ guildId: "guild-1" }))).rejects.toBeInstanceOf(FakeRedirectError);

    expect(redirectMock).toHaveBeenCalledTimes(1);
    const url = redirectMock.mock.calls[0][0] as string;
    expect(url).toContain("success=");
    expect(url).not.toContain("error=");
  });

  it("redirects to error when the post genuinely fails", async () => {
    vi.doMock("@/lib/discord/api", () => ({
      postChannelMessage: vi.fn().mockRejectedValue(new Error("boom")),
    }));
    const { testChannelAction } = await import("@/app/dashboard/[guildId]/actions");

    await expect(testChannelAction(formData({ guildId: "guild-1" }))).rejects.toBeInstanceOf(FakeRedirectError);

    expect(redirectMock).toHaveBeenCalledTimes(1);
    const url = redirectMock.mock.calls[0][0] as string;
    expect(url).toContain("error=");
  });
});

describe("testMirrorAction", () => {
  it("redirects to success (not error) when the mirror post actually succeeds", async () => {
    vi.doMock("@/lib/mirror", () => ({ sendMirror: vi.fn().mockResolvedValue(undefined) }));
    const { testMirrorAction } = await import("@/app/dashboard/[guildId]/actions");

    await expect(testMirrorAction(formData({ guildId: "guild-1" }))).rejects.toBeInstanceOf(FakeRedirectError);

    expect(redirectMock).toHaveBeenCalledTimes(1);
    const url = redirectMock.mock.calls[0][0] as string;
    expect(url).toContain("success=");
    expect(url).not.toContain("error=");
  });

  it("redirects to error when the mirror post genuinely fails", async () => {
    vi.doMock("@/lib/mirror", () => ({ sendMirror: vi.fn().mockRejectedValue(new Error("webhook gone")) }));
    const { testMirrorAction } = await import("@/app/dashboard/[guildId]/actions");

    await expect(testMirrorAction(formData({ guildId: "guild-1" }))).rejects.toBeInstanceOf(FakeRedirectError);

    expect(redirectMock).toHaveBeenCalledTimes(1);
    const url = redirectMock.mock.calls[0][0] as string;
    expect(url).toContain("error=");
  });
});
