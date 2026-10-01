import { and, eq } from "drizzle-orm";
import { schema, type Database } from "@/db";

/** How many more attempts a manually retried job gets before it can go dead again. */
const EXTRA_ATTEMPTS = 3;
const RETRY_DELIVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

export type RetryResult =
  | { ok: true; kind: string }
  | { ok: false; reason: "not_found" | "not_failed" | "token_expired" };

/**
 * Re-queues a failed (`dead`) or backing-off (`retrying`) job so the next
 * sweep -- or the `after()` run the caller kicks off -- picks it up now.
 *
 * Scoped to `guildId`: the job must belong to an interaction in that server,
 * so an admin can never retry (or even probe the existence of) another
 * server's job by guessing an id.
 *
 * Attempt numbers keep counting up so the history stays truthful; the job
 * just gets a few more attempts. A `reply` job can't be revived once its
 * interaction token has expired (15 min), since Discord would reject it; every
 * other kind doesn't use the token, so it gets a fresh delivery window.
 */
export async function retryJob(db: Database, guildId: string, jobId: string): Promise<RetryResult> {
  const [row] = await db
    .select({ job: schema.jobs })
    .from(schema.jobs)
    .innerJoin(schema.interactions, eq(schema.jobs.interactionId, schema.interactions.id))
    .where(and(eq(schema.jobs.id, jobId), eq(schema.interactions.guildId, guildId)))
    .limit(1);
  if (!row) return { ok: false, reason: "not_found" };

  const { job } = row;
  if (job.status !== "dead" && job.status !== "retrying") return { ok: false, reason: "not_failed" };

  const now = new Date();
  const usesInteractionToken = job.kind === "reply";
  if (usesInteractionToken && (!job.deadline || job.deadline.getTime() <= now.getTime())) {
    return { ok: false, reason: "token_expired" };
  }

  await db
    .update(schema.jobs)
    .set({
      status: "pending",
      runAt: now,
      lockedUntil: null,
      maxAttempts: job.attempts + EXTRA_ATTEMPTS,
      deadline: usesInteractionToken ? job.deadline : new Date(now.getTime() + RETRY_DELIVERY_WINDOW_MS),
      updatedAt: now,
    })
    .where(eq(schema.jobs.id, jobId));

  return { ok: true, kind: job.kind };
}
