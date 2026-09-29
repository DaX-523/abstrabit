import { describe, expect, it } from "vitest";
import { withDeadline, DeadlineExceededError } from "@/lib/deadline";

describe("withDeadline", () => {
  it("resolves with the work's result if it finishes in time", async () => {
    const result = await withDeadline("fast", 100, async () => "done");
    expect(result).toBe("done");
  });

  it("rejects with DeadlineExceededError if work is too slow", async () => {
    await expect(
      withDeadline("slow", 20, () => new Promise((resolve) => setTimeout(resolve, 200))),
    ).rejects.toBeInstanceOf(DeadlineExceededError);
  });

  it("propagates a rejection from the work itself, not a deadline error", async () => {
    await expect(
      withDeadline("fails", 100, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("includes the label in the deadline error message", async () => {
    await expect(
      withDeadline("db-write", 10, () => new Promise(() => {})),
    ).rejects.toThrow(/db-write/);
  });
});
