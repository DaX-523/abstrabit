import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/testDb";
import { schema } from "@/db";
import type { Database } from "@/db";
import { enqueueJob, claimDueJobs } from "@/lib/jobs/queue";
import { processJob, PermanentError } from "@/lib/jobs/runner";
import { retryJob } from "@/lib/jobs/retry";

let db: Database;
let close: () => Promise<void>;

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 4).toString("base64");
  ({ db, close } = await createTestDb());
  await db.insert(schema.guilds).values([
    { id: "guild-a", name: "A" },
    { id: "guild-b", name: "B" },
  ]);
  await db.insert(schema.interactions).values([
    { id: "int-a", guildId: "guild-a", type: 2, status: "completed" },
    { id: "int-b", guildId: "guild-b", type: 2, status: "completed" },
  ]);
});

afterEach(async () => {
  await close();
});

async function makeJob(
  interactionId: string,
  kind: "mirror" | "reply" | "channel_post",
  values: Partial<typeof schema.jobs.$inferInsert>,
): Promise<string> {
  await enqueueJob(db, { interactionId, kind, payload: {} });
  const job = await db.query.jobs.findFirst({
    where: (j, { and, eq }) => and(eq(j.interactionId, interactionId), eq(j.kind, kind)),
  });
  await db.update(schema.jobs).set(values).where(eq(schema.jobs.id, job!.id));
  return job!.id;
}

const getJob = (id: string) => db.query.jobs.findFirst({ where: (j, { eq }) => eq(j.id, id) });

describe("retryJob", () => {
  it("re-queues a dead mirror job to run now, with more attempts and a fresh delivery window", async () => {
    const id = await makeJob("int-a", "mirror", {
      status: "dead",
      attempts: 4,
      maxAttempts: 4,
      lastError: "Slack 500",
      deadline: new Date(Date.now() - 60_000),
    });

    expect(await retryJob(db, "guild-a", id)).toEqual({ ok: true, kind: "mirror" });

    const job = await getJob(id);
    expect(job?.status).toBe("pending");
    expect(job?.maxAttempts).toBeGreaterThan(4); // can go past the old cap
    expect(job?.attempts).toBe(4); // history stays truthful
    expect(job!.runAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(job!.deadline!.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    expect(job?.lockedUntil).toBeNull();
  });

  it("makes the job claimable by the next sweep", async () => {
    const id = await makeJob("int-a", "mirror", { status: "dead", attempts: 8, maxAttempts: 8 });
    await retryJob(db, "guild-a", id);

    const claimed = await claimDueJobs(db);
    expect(claimed.map((j) => j.id)).toContain(id);
  });

  it("can also pull a backing-off job forward", async () => {
    const id = await makeJob("int-a", "channel_post", {
      status: "retrying",
      attempts: 2,
      runAt: new Date(Date.now() + 10 * 60_000),
    });
    expect((await retryJob(db, "guild-a", id)).ok).toBe(true);
    expect((await getJob(id))!.runAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("refuses a job from another server, and leaves it untouched", async () => {
    const id = await makeJob("int-b", "mirror", { status: "dead", attempts: 3, maxAttempts: 3 });

    expect(await retryJob(db, "guild-a", id)).toEqual({ ok: false, reason: "not_found" });
    expect((await getJob(id))?.status).toBe("dead");
  });

  it("refuses an unknown job id", async () => {
    expect(await retryJob(db, "guild-a", "no-such-job")).toEqual({ ok: false, reason: "not_found" });
  });

  it("won't touch a job that's succeeded or still pending", async () => {
    const done = await makeJob("int-a", "mirror", { status: "succeeded" });
    const queued = await makeJob("int-a", "channel_post", { status: "pending" });

    expect(await retryJob(db, "guild-a", done)).toEqual({ ok: false, reason: "not_failed" });
    expect(await retryJob(db, "guild-a", queued)).toEqual({ ok: false, reason: "not_failed" });
  });

  it("won't revive a reply whose interaction token has expired", async () => {
    const id = await makeJob("int-a", "reply", {
      status: "dead",
      attempts: 1,
      deadline: new Date(Date.now() - 60_000),
    });

    expect(await retryJob(db, "guild-a", id)).toEqual({ ok: false, reason: "token_expired" });
    expect((await getJob(id))?.status).toBe("dead");
  });

  it("does retry a reply that failed while its token is still valid, without extending the token's deadline", async () => {
    const deadline = new Date(Date.now() + 5 * 60_000);
    const id = await makeJob("int-a", "reply", { status: "dead", attempts: 2, deadline });

    expect((await retryJob(db, "guild-a", id)).ok).toBe(true);
    expect((await getJob(id))?.deadline?.getTime()).toBe(deadline.getTime());
  });

  it("gives a retried job only a few more attempts: a still-failing job goes dead again", async () => {
    const id = await makeJob("int-a", "mirror", { status: "dead", attempts: 8, maxAttempts: 8 });
    await retryJob(db, "guild-a", id);
    const failing = async () => {
      throw new PermanentError("webhook deleted (404)", { httpStatus: 404 });
    };

    const [claimed] = await claimDueJobs(db);
    await processJob(db, claimed, { mirror: failing });

    const job = await getJob(id);
    expect(job?.status).toBe("dead");
    expect(job?.attempts).toBe(9);
    const attempts = await db.query.jobAttempts.findMany({ where: (a, { eq }) => eq(a.jobId, id) });
    expect(attempts.map((a) => a.attemptNumber)).toEqual([9]);
  });
});
