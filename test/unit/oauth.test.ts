import { describe, expect, it, vi, afterEach, beforeAll } from "vitest";

beforeAll(() => {
  process.env.DISCORD_APPLICATION_ID = "app-id-123";
  process.env.DISCORD_PUBLIC_KEY = "a".repeat(64);
  process.env.DISCORD_BOT_TOKEN = "bot-token-value";
  process.env.DISCORD_CLIENT_SECRET = "client-secret-value";
  process.env.DISCORD_OAUTH_REDIRECT_URI = "http://localhost:3000/api/discord/oauth/callback";
  process.env.DATABASE_URL = "pglite://";
  process.env.GROQ_API_KEY = "groq-key";
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 4).toString("base64");
  process.env.CRON_SECRET = "a".repeat(20);
  process.env.SESSION_SECRET = "b".repeat(20);
  process.env.APP_BASE_URL = "http://localhost:3000";
});

afterEach(() => vi.unstubAllGlobals());

describe("buildDiscordAuthorizeUrl", () => {
  it("includes the client id, bot+applications.commands scope, redirect uri, and state", async () => {
    const { buildDiscordAuthorizeUrl } = await import("@/lib/discord/oauth");
    const url = new URL(buildDiscordAuthorizeUrl("state-abc"));
    expect(url.searchParams.get("client_id")).toBe("app-id-123");
    expect(url.searchParams.get("scope")).toBe("bot applications.commands");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/discord/oauth/callback");
    expect(url.searchParams.get("state")).toBe("state-abc");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(Number(url.searchParams.get("permissions"))).toBeGreaterThan(0);
  });
});

describe("exchangeOAuthCode", () => {
  it("returns the parsed response on success, including the guild", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ access_token: "x", guild: { id: "g1", name: "My Server" } }), {
          status: 200,
        }),
      ),
    );
    const { exchangeOAuthCode } = await import("@/lib/discord/oauth");
    const result = await exchangeOAuthCode("some-code");
    expect(result.guild).toEqual({ id: "g1", name: "My Server" });
  });

  it("throws with a clear message on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("invalid_grant", { status: 400 })));
    const { exchangeOAuthCode } = await import("@/lib/discord/oauth");
    await expect(exchangeOAuthCode("bad-code")).rejects.toThrow(/OAuth token exchange failed/);
  });
});
