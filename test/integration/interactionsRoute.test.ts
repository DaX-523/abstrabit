import { describe, expect, it, beforeAll } from "vitest";
import { makeDevKeypair } from "../helpers/discordSign";

const keypair = makeDevKeypair();

beforeAll(() => {
  // Minimal env for getEnv() to validate successfully inside the route.
  process.env.DISCORD_APPLICATION_ID = "app-id";
  process.env.DISCORD_PUBLIC_KEY = keypair.publicKeyHex;
  process.env.DISCORD_BOT_TOKEN = "bot-token";
  process.env.DISCORD_CLIENT_SECRET = "client-secret";
  process.env.DISCORD_OAUTH_REDIRECT_URI = "http://localhost:3000/api/discord/oauth/callback";
  process.env.DATABASE_URL = "pglite://";
  process.env.GROQ_API_KEY = "groq-key";
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
  process.env.CRON_SECRET = "a".repeat(20);
  process.env.SESSION_SECRET = "b".repeat(20);
  process.env.APP_BASE_URL = "http://localhost:3000";
});

function buildRequest(rawBody: string, headers: Record<string, string>) {
  return new Request("http://localhost:3000/api/discord/interactions", {
    method: "POST",
    headers,
    body: rawBody,
  }) as unknown as import("next/server").NextRequest;
}

function signedHeaders(rawBody: string, timestamp = String(Math.floor(Date.now() / 1000))) {
  return {
    "content-type": "application/json",
    "x-signature-ed25519": keypair.sign(timestamp, rawBody),
    "x-signature-timestamp": timestamp,
  };
}

describe("POST /api/discord/interactions", () => {
  it("answers a PING with a PONG", async () => {
    const { POST } = await import("@/app/api/discord/interactions/route");
    const rawBody = JSON.stringify({ type: 1 });
    const res = await POST(buildRequest(rawBody, signedHeaders(rawBody)));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: 1 });
  });

  it("rejects a request with no signature headers at all", async () => {
    const { POST } = await import("@/app/api/discord/interactions/route");
    const rawBody = JSON.stringify({ type: 1 });
    const res = await POST(
      buildRequest(rawBody, { "content-type": "application/json" }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a forged signature", async () => {
    const { POST } = await import("@/app/api/discord/interactions/route");
    const rawBody = JSON.stringify({ type: 1 });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const res = await POST(
      buildRequest(rawBody, {
        "content-type": "application/json",
        "x-signature-ed25519": "ab".repeat(64), // well-formed hex, wrong signature
        "x-signature-timestamp": timestamp,
      }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a signature that was valid for a different body (tamper after signing)", async () => {
    const { POST } = await import("@/app/api/discord/interactions/route");
    const originalBody = JSON.stringify({ type: 1 });
    const headers = signedHeaders(originalBody);
    const tamperedBody = JSON.stringify({ type: 1, injected: true });
    const res = await POST(buildRequest(tamperedBody, headers));
    expect(res.status).toBe(401);
  });

  it("rejects a stale timestamp even with an otherwise-correct signature", async () => {
    const { POST } = await import("@/app/api/discord/interactions/route");
    const rawBody = JSON.stringify({ type: 1 });
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 10_000);
    const res = await POST(buildRequest(rawBody, signedHeaders(rawBody, staleTimestamp)));
    expect(res.status).toBe(401);
  });

  it("rejects an oversized payload with 413 before touching the signature", async () => {
    const { POST } = await import("@/app/api/discord/interactions/route");
    const hugeBody = JSON.stringify({ type: 1, filler: "x".repeat(2_000_000) });
    const res = await POST(
      buildRequest(hugeBody, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(hugeBody)),
        // deliberately no valid signature -- if this returned 401 instead of
        // 413 it would mean the size check isn't actually running first
        "x-signature-ed25519": "ab".repeat(64),
        "x-signature-timestamp": String(Math.floor(Date.now() / 1000)),
      }),
    );
    expect(res.status).toBe(413);
  });

  it("returns 400 for a validly signed but non-JSON body", async () => {
    const { POST } = await import("@/app/api/discord/interactions/route");
    const rawBody = "not json";
    const res = await POST(buildRequest(rawBody, signedHeaders(rawBody)));
    expect(res.status).toBe(400);
  });
});
