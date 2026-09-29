import { describe, expect, it, vi, afterEach } from "vitest";
import { log, redactForLog } from "@/lib/log";

describe("redactForLog", () => {
  it("redacts a discord-bot-token-shaped string", () => {
    // Built from parts, not one literal, so this fake example never looks
    // like a real credential to secret scanners (GitHub push protection
    // flagged the single-literal version of this line).
    const token = ["MTIzNDU2Nzg5MDEyMzQ1Njc4", "GhIjKl", "abcdefghijklmnopqrstuvwxyz012345"].join(".");
    expect(redactForLog(`token was ${token}`)).toBe("token was [redacted]");
  });

  it("redacts a Bearer/Bot authorization header value", () => {
    expect(redactForLog("Authorization: Bot abcdefghijklmnopqrstuvwxyz")).toContain(
      "[redacted]",
    );
  });

  it("redacts a slack webhook url", () => {
    const url = "https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXXXXXXXXXX";
    expect(redactForLog(url)).toBe("[redacted]");
  });

  it("redacts a discord webhook url", () => {
    const url = "https://discord.com/api/webhooks/123456789012345678/abcDEF-token";
    expect(redactForLog(url)).toBe("[redacted]");
  });

  it("leaves ordinary text untouched", () => {
    expect(redactForLog("the server is /report happy")).toBe("the server is /report happy");
  });
});

describe("log", () => {
  afterEach(() => vi.restoreAllMocks());

  it("redacts known-sensitive keys anywhere in the fields object, however deep", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    log.info("did a thing", {
      guild: { mirror_url: "https://hooks.slack.com/services/abc", nested: { token: "secret" } },
    });
    const printed = spy.mock.calls[0][0] as string;
    expect(printed).not.toContain("hooks.slack.com");
    expect(printed).not.toContain("secret");
    expect(JSON.parse(printed).guild.nested.token).toBe("[redacted]");
  });

  it("writes error level to console.error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    log.error("boom");
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
