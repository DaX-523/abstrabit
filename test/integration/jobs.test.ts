import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestDb } from "../helpers/testDb";
import { schema } from "@/db";
import type { Database } from "@/db";
import { enqueueJob, claimDueJobs } from "@/lib/jobs/queue";
import { processJob, runDueJobs, RetryableError, PermanentError, type HandlerRegistry } from "@/lib/jobs/runner";

let db: Database;
let close: () => Promise<void>;

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64");
  ({ db, close } = await createTestDb());
});

afterAll(async () => {
  await close();
});

let interactionCounter = 0;
async function makeInteraction(): Promise<string> {
  const id = `interaction-${++interactionCounter}`;
  await db.insert(schema.interactions).values({ id, type: 2, command: "report", status: "received" });
  return id;
}

describe("enqueueJob + claimDueJobs", () => {
  it("claims a freshly enqueued job", async () => {
    const interactionId = await makeInteraction();
    await enqueueJob(db, { interactionId, kind: "mirror", payload: { hello: "world" } });

    const claimed = await claimDueJobs(db, { limit: 10 });
    const ours = claimed.find((j) => j.interactionId === interactionId);
    expect(ours).toBeDefined();
    expect(ours!.status).toBe("running");
    expect(ours!.lockedUntil).not.toBeNull();
  });

  it("is idempotent on (interactionId, kind): a second enqueue is a no-op", async () => {
    const interactionId = await makeInteraction();
    await enqueueJob(db, { interactionId, kind: "mirror", payload: { attempt: 1 } });
    await enqueueJob(db, { interactionId, kind: "mirror", payload: { attempt: 2 } });

    const rows = await db.query.jobs.findMany({
      where: (j, { eq, and }) => and(eq(j.interactionId, interactionId), eq(j.kind, "mirror")),
    });
    expect(rows).toHaveLength(1);
  });

  it("does not re-claim a job that is already locked (simulating overlapping sweeps)", async () => {
    const interactionId = await makeInteraction();
    await enqueueJob(db, { interactionId, kind: "reply", payload: {} });

    const firstClaim = await claimDueJobs(db, { limit: 10, leaseMs: 60_000 });
    expect(firstClaim.some((j) => j.interactionId === interactionId)).toBe(true);

    const secondClaim = await claimDueJobs(db, { limit: 10, leaseMs: 60_000 });
    expect(secondClaim.some((j) => j.interactionId === interactionId)).toBe(false);
  });

  it("reclaims a job whose lease has expired", async () => {
    const interactionId = await makeInteraction();
    await enqueueJob(db, { interactionId, kind: "reply", payload: {} });

    // Claim with an already-expired lease (negative ms) to simulate a worker
    // that crashed long enough ago that its lease ran out.
    await claimDueJobs(db, { limit: 10, leaseMs: -1000 });

    const reclaimed = await claimDueJobs(db, { limit: 10, leaseMs: 60_000 });
    expect(reclaimed.some((j) => j.interactionId === interactionId)).toBe(true);
  });
});

describe("processJob", () => {
  it("marks a job succeeded and writes an attempt row", async () => {
    const interactionId = await makeInteraction();
    await enqueueJob(db, { interactionId, kind: "mirror", payload: { ok: true } });
    const [job] = await claimDueJobs(db, { limit: 10 });

    const handlers: HandlerRegistry = { mirror: async () => {} };
    await processJob(db, job, handlers);

    const updated = await db.query.jobs.findFirst({ where: (j, { eq }) => eq(j.id, job.id) });
    expect(updated?.status).toBe("succeeded");
    expect(updated?.attempts).toBe(1);

    const attempts = await db.query.jobAttempts.findMany({ where: (a, { eq }) => eq(a.jobId, job.id) });
    expect(attempts).toHaveLength(1);
    expect(attempts[0].outcome).toBe("succeeded");
  });

  it("retries on a RetryableError and schedules the next run in the future", async () => {
    const interactionId = await makeInteraction();
    await enqueueJob(db, { interactionId, kind: "mirror", payload: {} });
    const [job] = await claimDueJobs(db, { limit: 10 });

    const handlers: HandlerRegistry = {
      mirror: async () => {
        throw new RetryableError("upstream 500", { httpStatus: 500 });
      },
    };
    const before = Date.now();
    await processJob(db, job, handlers);

    const updated = await db.query.jobs.findFirst({ where: (j, { eq }) => eq(j.id, job.id) });
    expect(updated?.status).toBe("retrying");
    expect(updated?.attempts).toBe(1);
    expect(updated?.runAt.getTime()).toBeGreaterThan(before);
    expect(updated?.lastError).toContain("upstream 500");
  });

  it("honors an explicit retryAfterMs (e.g. from a 429) instead of computed backoff", async () => {
    const interactionId = await makeInteraction();
    await enqueueJob(db, { interactionId, kind: "mirror", payload: {} });
    const [job] = await claimDueJobs(db, { limit: 10 });

    const handlers: HandlerRegistry = {
      mirror: async () => {
        throw new RetryableError("rate limited", { httpStatus: 429, retryAfterMs: 3_600_000 });
      },
    };
    const before = Date.now();
    await processJob(db, job, handlers);

    const updated = await db.query.jobs.findFirst({ where: (j, { eq }) => eq(j.id, job.id) });
    // Should be roughly an hour out, not the small default backoff.
    expect(updated?.runAt.getTime()).toBeGreaterThan(before + 3_000_000);
  });

  it("goes straight to dead on a PermanentError, without retrying", async () => {
    const interactionId = await makeInteraction();
    await enqueueJob(db, { interactionId, kind: "mirror", payload: {} });
    const [job] = await claimDueJobs(db, { limit: 10 });

    const handlers: HandlerRegistry = {
      mirror: async () => {
        throw new PermanentError("webhook deleted", { httpStatus: 404 });
      },
    };
    await processJob(db, job, handlers);

    const updated = await db.query.jobs.findFirst({ where: (j, { eq }) => eq(j.id, job.id) });
    expect(updated?.status).toBe("dead");
    expect(updated?.attempts).toBe(1);
    expect(updated?.lastError).toContain("webhook deleted");
  });

  it("goes dead once max attempts is reached even for a retryable error", async () => {
    const interactionId = await makeInteraction();
    await enqueueJob(db, { interactionId, kind: "mirror", payload: {}, maxAttempts: 1 });
    const [job] = await claimDueJobs(db, { limit: 10 });

    const handlers: HandlerRegistry = {
      mirror: async () => {
        throw new RetryableError("still down");
      },
    };
    await processJob(db, job, handlers);

    const updated = await db.query.jobs.findFirst({ where: (j, { eq }) => eq(j.id, job.id) });
    expect(updated?.status).toBe("dead");
  });

  it("goes dead if the job's deadline has already passed", async () => {
    const interactionId = await makeInteraction();
    await enqueueJob(db, {
      interactionId,
      kind: "reply",
      payload: {},
      deadline: new Date(Date.now() - 1000),
    });
    const [job] = await claimDueJobs(db, { limit: 10 });

    const handlers: HandlerRegistry = { reply: async () => {} };
    await processJob(db, job, handlers);

    const updated = await db.query.jobs.findFirst({ where: (j, { eq }) => eq(j.id, job.id) });
    expect(updated?.status).toBe("dead");
    expect(updated?.lastError).toContain("deadline");
  });

  it("dead-letters a job with no registered handler instead of throwing", async () => {
    const interactionId = await makeInteraction();
    await enqueueJob(db, { interactionId, kind: "ai_enrich", payload: {} });
    const [job] = await claimDueJobs(db, { limit: 10 });

    await expect(processJob(db, job, {})).resolves.not.toThrow();

    const updated = await db.query.jobs.findFirst({ where: (j, { eq }) => eq(j.id, job.id) });
    expect(updated?.status).toBe("dead");
    expect(updated?.lastError).toContain("no handler registered");
  });
});

describe("runDueJobs", () => {
  it("processes multiple claimed jobs in one sweep", async () => {
    const a = await makeInteraction();
    const b = await makeInteraction();
    await enqueueJob(db, { interactionId: a, kind: "mirror", payload: {} });
    await enqueueJob(db, { interactionId: b, kind: "mirror", payload: {} });

    const calls: string[] = [];
    const handlers: HandlerRegistry = {
      mirror: async (_payload, ctx) => {
        calls.push(ctx.job.interactionId);
      },
    };
    const { processed } = await runDueJobs(db, handlers, { limit: 10 });
    expect(processed).toBeGreaterThanOrEqual(2);
    expect(calls).toEqual(expect.arrayContaining([a, b]));
  });
});
