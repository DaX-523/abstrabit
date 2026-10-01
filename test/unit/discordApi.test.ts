import { describe, expect, it, vi, afterEach, beforeAll } from "vitest";
import { RetryableError, PermanentError } from "@/lib/jobs/runner";

beforeAll(() => {
  process.env.DISCORD_APPLICATION_ID = "app-id";
  process.env.DISCORD_PUBLIC_KEY = "a".repeat(64);
  process.env.DISCORD_BOT_TOKEN = "bot-token-value";
  process.env.DISCORD_CLIENT_SECRET = "client-secret";
  process.env.DISCORD_OAUTH_REDIRECT_URI = "http://localhost:3000/api/discord/oauth/callback";
  process.env.DATABASE_URL = "pglite://";
  process.env.GROQ_API_KEY = "groq-key";
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 2).toString("base64");
  process.env.CRON_SECRET = "a".repeat(20);
  process.env.SESSION_SECRET = "b".repeat(20);
  process.env.APP_BASE_URL = "http://localhost:3000";
});

afterEach(() => vi.unstubAllGlobals());

describe("discord/api", () => {
  it("sends the bot token as an Authorization header", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const { postChannelMessage } = await import("@/lib/discord/api");
    await postChannelMessage("chan-1", { content: "hi" });
    const [, init] = fetchSpy.mock.calls[0];
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bot bot-token-value");
  });

  it("throws RetryableError with retryAfterMs on a 429 with a retry_after body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ retry_after: 1.5 }), { status: 429 }),
      ),
    );
    const { postChannelMessage } = await import("@/lib/discord/api");
    const err = await postChannelMessage("chan-1", {}).catch((e) => e);
    expect(err).toBeInstanceOf(RetryableError);
    expect((err as RetryableError).retryAfterMs).toBe(1500);
  });

  it("throws RetryableError on a 5xx", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("oops", { status: 502 })));
    const { postChannelMessage } = await import("@/lib/discord/api");
    await expect(postChannelMessage("chan-1", {})).rejects.toBeInstanceOf(RetryableError);
  });

  it("throws PermanentError on a 404 (e.g. channel deleted)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not found", { status: 404 })));
    const { postChannelMessage } = await import("@/lib/discord/api");
    await expect(postChannelMessage("chan-1", {})).rejects.toBeInstanceOf(PermanentError);
  });

  it("throws PermanentError on a 401 (bad token)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 })));
    const { postChannelMessage } = await import("@/lib/discord/api");
    await expect(postChannelMessage("chan-1", {})).rejects.toBeInstanceOf(PermanentError);
  });

  it("throws RetryableError on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network down")));
    const { postChannelMessage } = await import("@/lib/discord/api");
    await expect(postChannelMessage("chan-1", {})).rejects.toBeInstanceOf(RetryableError);
  });

  it("returns the parsed JSON body on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "msg-1" }), { status: 200 })));
    const { postChannelMessage } = await import("@/lib/discord/api");
    const result = await postChannelMessage("chan-1", {});
    expect(result).toEqual({ id: "msg-1" });
  });

  describe("never puts the interaction token in an error message", () => {
    // A realistic-length interaction token (they're ~70+ url-safe characters).
    const token = ["aW50ZXJhY3Rpb246MTU1NDg", "1ODUxNjI1MzgwNjY3Mjo", "xYWJjZGVmZ2hpamtsbW5vcA"].join("");
    const call = async () => {
      const { patchOriginalResponse } = await import("@/lib/discord/api");
      return patchOriginalResponse("1554818516253806672", token, { content: "hi" }).then(
        () => new Error("expected the call to fail"),
        (e: Error) => e,
      );
    };

    it("on a permanent 4xx (the case seen on the dashboard)", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"message":"Unknown Webhook"}', { status: 404 })));
      const err = await call();
      expect(err).toBeInstanceOf(PermanentError);
      expect(err.message).not.toContain(token);
      expect(err.message).toContain("/webhooks/1554818516253806672/[token]/messages/@original");
      expect(err.message).toContain("Unknown Webhook"); // the useful part is kept
    });

    it("on a 5xx, which is retried and so is stored while the token is still valid", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("oops", { status: 503 })));
      const err = await call();
      expect(err).toBeInstanceOf(RetryableError);
      expect(err.message).not.toContain(token);
    });

    it("on a 429", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 429 })));
      const err = await call();
      expect(err.message).not.toContain(token);
    });

    it("on a network error", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network down")));
      const err = await call();
      expect(err).toBeInstanceOf(RetryableError);
      expect(err.message).not.toContain(token);
    });

    it("but leaves ordinary paths (channel ids) readable", async () => {
      const { redactInteractionToken } = await import("@/lib/discord/api");
      expect(redactInteractionToken("/channels/123/messages")).toBe("/channels/123/messages");
      expect(redactInteractionToken(`/webhooks/42/${token}?wait=true`)).toBe("/webhooks/42/[token]?wait=true");
    });
  });
});
