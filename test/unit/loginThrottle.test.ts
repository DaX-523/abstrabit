import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createTestDb } from "../helpers/testDb";
import type { Database } from "@/db";
import { recordLoginAttempt, isLoginThrottled } from "@/lib/loginThrottle";

describe("login throttling", () => {
  let db: Database;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
  });

  afterEach(() => close());

  it("is not throttled with no prior attempts", async () => {
    expect(await isLoginThrottled(db, { email: "a@example.com", ip: "1.1.1.1" })).toBe(false);
  });

  it("is not throttled by successful attempts, however many", async () => {
    for (let i = 0; i < 10; i++) {
      await recordLoginAttempt(db, { email: "a@example.com", ip: "1.1.1.1", succeeded: true });
    }
    expect(await isLoginThrottled(db, { email: "a@example.com", ip: "1.1.1.1" })).toBe(false);
  });

  it("throttles after 5 failed attempts for the same email", async () => {
    for (let i = 0; i < 5; i++) {
      await recordLoginAttempt(db, { email: "a@example.com", ip: "1.1.1.1", succeeded: false });
    }
    expect(await isLoginThrottled(db, { email: "a@example.com", ip: "1.1.1.1" })).toBe(true);
  });

  it("throttles by IP too, even across different emails (credential stuffing)", async () => {
    for (let i = 0; i < 5; i++) {
      await recordLoginAttempt(db, { email: `user${i}@example.com`, ip: "9.9.9.9", succeeded: false });
    }
    expect(await isLoginThrottled(db, { email: "someone-else@example.com", ip: "9.9.9.9" })).toBe(true);
  });

  it("does not throttle an unrelated email/IP pair", async () => {
    for (let i = 0; i < 5; i++) {
      await recordLoginAttempt(db, { email: "attacker@example.com", ip: "2.2.2.2", succeeded: false });
    }
    expect(await isLoginThrottled(db, { email: "victim@example.com", ip: "3.3.3.3" })).toBe(false);
  });

  it("email matching is case-insensitive", async () => {
    for (let i = 0; i < 5; i++) {
      await recordLoginAttempt(db, { email: "Admin@Example.com", ip: "1.1.1.1", succeeded: false });
    }
    expect(await isLoginThrottled(db, { email: "admin@example.com", ip: "4.4.4.4" })).toBe(true);
  });
});
