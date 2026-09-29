import { describe, expect, it, beforeEach } from "vitest";
import { getEnv, __resetEnvCacheForTests } from "@/lib/env";

const validBase: Record<string, string> = {
  DISCORD_APPLICATION_ID: "123",
  DISCORD_PUBLIC_KEY: "a".repeat(64),
  DISCORD_BOT_TOKEN: "bot-token",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_OAUTH_REDIRECT_URI: "http://localhost:3000/api/discord/oauth/callback",
  DATABASE_URL: "postgres://user:pass@localhost:5432/db",
  GROQ_API_KEY: "groq-key",
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  CRON_SECRET: "a".repeat(20),
  SESSION_SECRET: "b".repeat(20),
  APP_BASE_URL: "http://localhost:3000",
};

function setEnv(overrides: Record<string, string | undefined> = {}) {
  const merged = { ...validBase, ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("getEnv", () => {
  beforeEach(() => __resetEnvCacheForTests());

  it("parses a fully valid environment", () => {
    setEnv();
    const env = getEnv();
    expect(env.DISCORD_APPLICATION_ID).toBe("123");
    expect(env.GROQ_MODEL).toBe("openai/gpt-oss-20b"); // default applied
  });

  it("rejects a public key that isn't 64 hex chars", () => {
    setEnv({ DISCORD_PUBLIC_KEY: "not-hex" });
    expect(() => getEnv()).toThrow(/DISCORD_PUBLIC_KEY/);
  });

  it("rejects an encryption key that isn't exactly 32 bytes", () => {
    setEnv({ ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") });
    expect(() => getEnv()).toThrow(/ENCRYPTION_KEY/);
  });

  it("rejects a short cron secret", () => {
    setEnv({ CRON_SECRET: "short" });
    expect(() => getEnv()).toThrow(/CRON_SECRET/);
  });

  it("caches the result after first successful parse", () => {
    setEnv();
    const first = getEnv();
    // mutate process.env after the fact; cached value should not change
    process.env.DISCORD_APPLICATION_ID = "different";
    const second = getEnv();
    expect(second).toBe(first);
    expect(second.DISCORD_APPLICATION_ID).toBe("123");
  });

  it("parses ALLOW_SIGNUP=true as boolean true and anything else as false", () => {
    setEnv({ ALLOW_SIGNUP: "true" });
    expect(getEnv().ALLOW_SIGNUP).toBe(true);
    __resetEnvCacheForTests();
    setEnv({ ALLOW_SIGNUP: "nope" });
    expect(getEnv().ALLOW_SIGNUP).toBe(false);
  });
});
