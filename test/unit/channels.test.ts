import { describe, expect, it, vi, afterEach, beforeAll } from "vitest";

beforeAll(() => {
  process.env.DISCORD_APPLICATION_ID = "bot-1";
  process.env.DISCORD_PUBLIC_KEY = "a".repeat(64);
  process.env.DISCORD_BOT_TOKEN = "bot-token-value";
  process.env.DISCORD_CLIENT_SECRET = "client-secret-value";
  process.env.DISCORD_OAUTH_REDIRECT_URI = "http://localhost:3000/api/discord/oauth/callback";
  process.env.DATABASE_URL = "pglite://";
  process.env.GROQ_API_KEY = "groq-key";
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 6).toString("base64");
  process.env.CRON_SECRET = "a".repeat(20);
  process.env.SESSION_SECRET = "b".repeat(20);
  process.env.APP_BASE_URL = "http://localhost:3000";
});

afterEach(() => vi.unstubAllGlobals());

const GUILD_ID = "guild-1";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("listPostableChannels", () => {
  it("includes a text channel the bot can post in and excludes one it can't", async () => {
    const fetchSpy = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/channels")) {
        return Promise.resolve(
          jsonResponse([
            { id: "chan-ok", name: "general", type: 0, permission_overwrites: [] },
            {
              id: "chan-blocked",
              name: "secret",
              type: 0,
              permission_overwrites: [{ id: GUILD_ID, type: 0, allow: "0", deny: (1n << 10n).toString() }],
            },
            { id: "chan-voice", name: "Voice", type: 2, permission_overwrites: [] }, // not a text channel
          ]),
        );
      }
      if (url.includes("/roles")) {
        return Promise.resolve(
          jsonResponse([{ id: GUILD_ID, permissions: ((1n << 10n) | (1n << 11n) | (1n << 14n)).toString() }]),
        );
      }
      if (url.includes("/members/")) {
        return Promise.resolve(jsonResponse({ roles: [] }));
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
    vi.stubGlobal("fetch", fetchSpy);

    const { listPostableChannels } = await import("@/lib/discord/channels");
    const channels = await listPostableChannels(GUILD_ID);

    expect(channels).toEqual([{ id: "chan-ok", name: "general" }]);
  });
});
