import { describe, expect, it } from "vitest";
import { verifyDiscordSignature } from "@/lib/discord/verify";
import { makeDevKeypair } from "../helpers/discordSign";

const keypair = makeDevKeypair();
const now = Math.floor(Date.now() / 1000);

function validRequest(overrides: Partial<{ rawBody: string; timestamp: string }> = {}) {
  const rawBody = overrides.rawBody ?? JSON.stringify({ type: 1 });
  const timestamp = overrides.timestamp ?? String(now);
  return { rawBody, timestamp, signature: keypair.sign(timestamp, rawBody) };
}

describe("verifyDiscordSignature", () => {
  it("accepts a validly signed request", () => {
    const { rawBody, timestamp, signature } = validRequest();
    const result = verifyDiscordSignature({
      rawBody,
      signature,
      timestamp,
      publicKey: keypair.publicKeyHex,
      now,
    });
    expect(result).toEqual({ ok: true });
  });

  it("rejects when the body was tampered with after signing", () => {
    const { timestamp, signature } = validRequest();
    const result = verifyDiscordSignature({
      rawBody: JSON.stringify({ type: 1, extra: "injected" }),
      signature,
      timestamp,
      publicKey: keypair.publicKeyHex,
      now,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a signature made with the wrong key", () => {
    const otherKeypair = makeDevKeypair();
    const rawBody = JSON.stringify({ type: 1 });
    const timestamp = String(now);
    const signature = otherKeypair.sign(timestamp, rawBody);
    const result = verifyDiscordSignature({
      rawBody,
      signature,
      timestamp,
      publicKey: keypair.publicKeyHex, // verifying against a DIFFERENT public key
      now,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects missing signature header", () => {
    const { rawBody, timestamp } = validRequest();
    const result = verifyDiscordSignature({
      rawBody,
      signature: null,
      timestamp,
      publicKey: keypair.publicKeyHex,
      now,
    });
    expect(result).toEqual({ ok: false, reason: "missing signature headers" });
  });

  it("rejects missing timestamp header", () => {
    const { rawBody, signature } = validRequest();
    const result = verifyDiscordSignature({
      rawBody,
      signature,
      timestamp: null,
      publicKey: keypair.publicKeyHex,
      now,
    });
    expect(result).toEqual({ ok: false, reason: "missing signature headers" });
  });

  it("rejects a non-hex signature", () => {
    const { rawBody, timestamp } = validRequest();
    const result = verifyDiscordSignature({
      rawBody,
      signature: "not-hex-at-all!!",
      timestamp,
      publicKey: keypair.publicKeyHex,
      now,
    });
    expect(result).toEqual({ ok: false, reason: "malformed signature" });
  });

  it("rejects a signature of the wrong length even if valid hex", () => {
    const { rawBody, timestamp } = validRequest();
    const result = verifyDiscordSignature({
      rawBody,
      signature: "ab".repeat(10), // valid hex, wrong length
      timestamp,
      publicKey: keypair.publicKeyHex,
      now,
    });
    expect(result).toEqual({ ok: false, reason: "malformed signature" });
  });

  it("rejects a non-numeric timestamp", () => {
    const rawBody = JSON.stringify({ type: 1 });
    const signature = keypair.sign("not-a-number", rawBody);
    const result = verifyDiscordSignature({
      rawBody,
      signature,
      timestamp: "not-a-number",
      publicKey: keypair.publicKeyHex,
      now,
    });
    expect(result).toEqual({ ok: false, reason: "malformed timestamp" });
  });

  it("rejects a stale timestamp outside the allowed skew", () => {
    const staleTimestamp = String(now - 301);
    const rawBody = JSON.stringify({ type: 1 });
    const signature = keypair.sign(staleTimestamp, rawBody);
    const result = verifyDiscordSignature({
      rawBody,
      signature,
      timestamp: staleTimestamp,
      publicKey: keypair.publicKeyHex,
      now,
    });
    expect(result).toEqual({ ok: false, reason: "timestamp outside allowed window" });
  });

  it("rejects a timestamp from the future outside the allowed skew", () => {
    const futureTimestamp = String(now + 301);
    const rawBody = JSON.stringify({ type: 1 });
    const signature = keypair.sign(futureTimestamp, rawBody);
    const result = verifyDiscordSignature({
      rawBody,
      signature,
      timestamp: futureTimestamp,
      publicKey: keypair.publicKeyHex,
      now,
    });
    expect(result.ok).toBe(false);
  });

  it("accepts a timestamp right at the edge of the allowed skew", () => {
    const edgeTimestamp = String(now - 300);
    const rawBody = JSON.stringify({ type: 1 });
    const signature = keypair.sign(edgeTimestamp, rawBody);
    const result = verifyDiscordSignature({
      rawBody,
      signature,
      timestamp: edgeTimestamp,
      publicKey: keypair.publicKeyHex,
      now,
    });
    expect(result).toEqual({ ok: true });
  });

  it("rejects a malformed public key rather than throwing", () => {
    const { rawBody, timestamp, signature } = validRequest();
    const result = verifyDiscordSignature({
      rawBody,
      signature,
      timestamp,
      publicKey: "too-short",
      now,
    });
    expect(result).toEqual({ ok: false, reason: "malformed public key" });
  });
});
