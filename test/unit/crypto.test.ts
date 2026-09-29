import { describe, expect, it, beforeAll } from "vitest";

// crypto.ts reads ENCRYPTION_KEY via getEnv() lazily, so set env before import.
beforeAll(() => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});

describe("encrypt/decrypt", () => {
  it("round-trips a plaintext string", async () => {
    const { encrypt, decrypt } = await import("@/lib/crypto");
    const plaintext = "https://hooks.slack.com/services/T000/B000/secrettoken";
    const ciphertext = encrypt(plaintext);
    expect(ciphertext).not.toContain("hooks.slack.com");
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it("produces different ciphertext each time (random iv)", async () => {
    const { encrypt } = await import("@/lib/crypto");
    const a = encrypt("same input");
    const b = encrypt("same input");
    expect(a).not.toBe(b);
  });

  it("fails to decrypt if the ciphertext is tampered with", async () => {
    const { encrypt, decrypt } = await import("@/lib/crypto");
    const ciphertext = encrypt("integrity matters");
    const raw = Buffer.from(ciphertext, "base64");
    raw[raw.length - 1] ^= 0xff; // flip a bit in the ciphertext
    const tampered = raw.toString("base64");
    expect(() => decrypt(tampered)).toThrow();
  });

  it("fails to decrypt with the wrong key", async () => {
    const { encrypt, decrypt } = await import("@/lib/crypto");
    const ciphertext = encrypt("secret");
    const original = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    expect(() => decrypt(ciphertext)).toThrow();
    process.env.ENCRYPTION_KEY = original; // restore for any later tests in this file
  });
});

describe("maskUrl", () => {
  it("shows host and last 4 chars only", async () => {
    const { maskUrl } = await import("@/lib/crypto");
    const masked = maskUrl("https://hooks.slack.com/services/T000/B000/abcd1234wxyz");
    expect(masked).toBe("hooks.slack.com/…/•••wxyz");
    expect(masked).not.toContain("T000");
  });

  it("degrades gracefully on an invalid url", async () => {
    const { maskUrl } = await import("@/lib/crypto");
    expect(maskUrl("not-a-url")).toBe("•••invalid-url");
  });
});
