import { describe, expect, it, beforeAll, afterEach, vi } from "vitest";
import path from "node:path";
import { migrate } from "drizzle-orm/pglite/migrator";
import { getDb, schema } from "@/db";
import type { Database } from "@/db";
import { replyHandler } from "@/lib/jobs/handlers/reply";
import { channelPostHandler } from "@/lib/jobs/handlers/channelPost";
import { mirrorHandler } from "@/lib/jobs/handlers/mirror";
import { PermanentError } from "@/lib/jobs/runner";

// The handlers under test call getDb() (a module-level singleton reading
// DATABASE_URL), not an injected db -- that's how they'll actually run in
// production (called from the job runner, not from the interactions
// transaction). So this suite points DATABASE_URL at a fresh in-memory
// PGlite and migrates it once, up front, rather than using createTestDb().
let db: Database;

beforeAll(async () => {
  process.env.DISCORD_APPLICATION_ID = "app-id";
  process.env.DISCORD_PUBLIC_KEY = "a".repeat(64);
  process.env.DISCORD_BOT_TOKEN = "bot-token-value";
  process.env.DISCORD_CLIENT_SECRET = "client-secret";
  process.env.DISCORD_OAUTH_REDIRECT_URI = "http://localhost:3000/api/discord/oauth/callback";
  process.env.GROQ_API_KEY = "groq-key";
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 8).toString("base64");
  process.env.CRON_SECRET = "a".repeat(20);
  process.env.SESSION_SECRET = "b".repeat(20);
  process.env.APP_BASE_URL = "http://localhost:3000";
  process.env.DATABASE_URL = "pglite://";

  db = getDb();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await migrate(db as any, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
});

afterEach(() => vi.unstubAllGlobals());

async function seedReport(overrides: Partial<typeof schema.reports.$inferInsert> = {}) {
  const guildId = overrides.guildId ?? "guild-1";
  const reportId = overrides.id ?? crypto.randomUUID();
  const interactionId = `interaction-for-${reportId}`;

  await db.insert(schema.guilds).values({ id: guildId, name: "Test Guild" }).onConflictDoNothing({
    target: schema.guilds.id,
  });
  await db
    .insert(schema.interactions)
    .values({ id: interactionId, type: 2, command: "report", status: "processing" })
    .onConflictDoNothing({ target: schema.interactions.id });
  await db.insert(schema.reports).values({
    id: reportId,
    guildId,
    interactionId,
    authorId: "user-1",
    authorUsername: "alice",
    body: "something broke",
    priority: "medium",
    status: "open",
    ...overrides,
  });
  return reportId;
}

describe("replyHandler", () => {
  it("PATCHes @original with the report's priority", async () => {
    const reportId = await seedReport();
    const fetchSpy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await replyHandler({ reportId, applicationId: "app-1", interactionToken: "tok-1" }, { job: {} as never });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("/webhooks/app-1/tok-1/messages/@original");
    expect(init.method).toBe("PATCH");
    const body = JSON.parse(init.body as string);
    expect(body.content).toContain("medium");
    expect(body.allowed_mentions).toEqual({ parse: [] });
  });
});

describe("channelPostHandler", () => {
  it("posts an embed and records the message id on the report", async () => {
    const reportId = await seedReport({ guildId: "guild-2" });
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "msg-123" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await channelPostHandler({ reportId, guildId: "guild-2", channelId: "chan-1" }, { job: {} as never });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("/channels/chan-1/messages");
    const body = JSON.parse(init.body as string);
    expect(body.embeds[0].description).toContain("something broke");
    expect(body.allowed_mentions).toEqual({ parse: [] });

    const updated = await db.query.reports.findFirst({ where: (r, { eq }) => eq(r.id, reportId) });
    expect(updated?.messageId).toBe("msg-123");
  });

  it("throws PermanentError if the report doesn't exist", async () => {
    await expect(
      channelPostHandler({ reportId: "missing", guildId: "guild-2", channelId: "chan-1" }, { job: {} as never }),
    ).rejects.toBeInstanceOf(PermanentError);
  });
});

describe("mirrorHandler", () => {
  it("decrypts the guild's mirror url and posts to it", async () => {
    const { encrypt } = await import("@/lib/crypto");
    const guildId = "guild-mirror-1";
    await db
      .insert(schema.guilds)
      .values({
        id: guildId,
        name: "Mirror Guild",
        mirrorKind: "slack",
        mirrorUrlEnc: encrypt("https://hooks.slack.com/services/T0/B0/xyz"),
      })
      .onConflictDoNothing({ target: schema.guilds.id });
    const reportId = await seedReport({ guildId });

    const fetchSpy = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await mirrorHandler({ reportId, guildId }, { job: {} as never });

    const [url] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("https://hooks.slack.com/services/T0/B0/xyz");
  });

  it("throws PermanentError if the guild has no mirror configured", async () => {
    const reportId = await seedReport({ guildId: "guild-no-mirror" });
    await expect(mirrorHandler({ reportId, guildId: "guild-no-mirror" }, { job: {} as never })).rejects.toBeInstanceOf(
      PermanentError,
    );
  });
});
