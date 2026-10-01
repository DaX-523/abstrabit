import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { createTestDb } from "../helpers/testDb";
import { schema } from "@/db";
import type { Database } from "@/db";
import { enqueueJob } from "@/lib/jobs/queue";

let db: Database;
let close: () => Promise<void>;

vi.mock("@/db", async () => {
  const actual = await vi.importActual<typeof import("@/db")>("@/db");
  return { ...actual, getDb: () => db };
});

const CRON_SECRET = "c".repeat(24);

beforeAll(() => {
  process.env.DISCORD_APPLICATION_ID = "app-id";
  process.env.DISCORD_PUBLIC_KEY = "a".repeat(64);
  process.env.DISCORD_BOT_TOKEN = "bot-token";
  process.env.DISCORD_CLIENT_SECRET = "client-secret";
  process.env.DISCORD_OAUTH_REDIRECT_URI = "http://localhost:3000/api/discord/oauth/callback";
  process.env.DATABASE_URL = "pglite://";
  process.env.GROQ_API_KEY = "groq-key";
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64");
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.SESSION_SECRET = "b".repeat(20);
  process.env.APP_BASE_URL = "http://localhost:3000";
});

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  await close();
});

function cronRequest(method: "GET" | "POST", auth?: string) {
  return new Request("http://localhost:3000/api/cron/jobs", {
    method,
    headers: auth ? { authorization: auth } : {},
  }) as unknown as import("next/server").NextRequest;
}

describe("/api/cron/jobs", () => {
  it.each(["GET", "POST"] as const)("rejects %s without the bearer secret", async (method) => {
    const route = await import("@/app/api/cron/jobs/route");
    expect((await route[method](cronRequest(method))).status).toBe(401);
    expect((await route[method](cronRequest(method, "Bearer wrong-secret-value"))).status).toBe(401);
  });

  it.each(["GET", "POST"] as const)("runs a sweep on %s with the bearer secret", async (method) => {
    const route = await import("@/app/api/cron/jobs/route");
    const res = await route[method](cronRequest(method, `Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ processed: 0 });
  });
});

describe("/api/health", () => {
  it("reports aggregate queue counts and nothing else", async () => {
    await db.insert(schema.interactions).values({ id: "i-1", type: 2, status: "completed" });
    await enqueueJob(db, { interactionId: "i-1", kind: "mirror", payload: { secret: "do-not-leak" } });

    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toMatchObject({ ok: true, db: "ok", jobs: { pending: 1, retrying: 0, dead24h: 0 } });
    expect(body.jobs.oldestUnfinishedAgeSeconds).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(body)).not.toContain("do-not-leak");
    expect(JSON.stringify(body)).not.toContain("i-1");
  });

  it("returns 503 rather than throwing when the database is unreachable", async () => {
    await close();
    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, db: "unreachable" });
    ({ db, close } = await createTestDb()); // so afterEach has something to close
  });
});
