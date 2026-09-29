import { eq, inArray, sql } from "drizzle-orm";
import { schema, rowsOf, type Database, type Queryable } from "@/db";
import { encrypt } from "@/lib/crypto";

export type JobRow = typeof schema.jobs.$inferSelect;
export type JobKind = JobRow["kind"];

const DEFAULT_LEASE_MS = 2 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_CLAIM_LIMIT = 25;

export interface EnqueueParams {
  interactionId: string;
  kind: JobKind;
  payload: unknown;
  /** Hard stop for this job's usefulness, e.g. an interaction token's 15-min expiry. */
  deadline?: Date;
  maxAttempts?: number;
}

/**
 * Enqueues a job. Idempotent on (interactionId, kind): if this interaction
 * already has a job of this kind queued (e.g. because the same interaction
 * delivery is being processed twice), the second insert is a no-op rather
 * than a duplicate row -- this is what stops a retried Discord delivery from
 * ever producing two `mirror` or `channel_post` jobs for the same command.
 *
 * The payload is encrypted at rest because it may carry the interaction
 * token, a 15-minute-lived credential.
 */
export async function enqueueJob(db: Queryable, params: EnqueueParams): Promise<void> {
  await db
    .insert(schema.jobs)
    .values({
      interactionId: params.interactionId,
      kind: params.kind,
      payloadEnc: encrypt(JSON.stringify(params.payload)),
      deadline: params.deadline,
      maxAttempts: params.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    })
    .onConflictDoNothing({ target: [schema.jobs.interactionId, schema.jobs.kind] });
}

export interface ClaimOptions {
  limit?: number;
  leaseMs?: number;
}

/**
 * Atomically claims up to `limit` due jobs for this worker: `FOR UPDATE SKIP
 * LOCKED` means two overlapping sweeper invocations (e.g. a slow one still
 * running when the next minute's cron fires) never pick up the same row, and
 * the `locked_until` lease means a worker that crashes mid-job doesn't hold
 * the job forever -- once the lease expires, the next sweep claims it again.
 */
export async function claimDueJobs(db: Database, opts: ClaimOptions = {}): Promise<JobRow[]> {
  const limit = opts.limit ?? DEFAULT_CLAIM_LIMIT;
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + leaseMs);

  return db.transaction(async (tx) => {
    // "running" is included alongside "pending"/"retrying" because a worker
    // that crashed mid-job leaves its row at status "running" forever
    // otherwise; the locked_until check is what actually excludes jobs a
    // *live* worker is currently holding.
    const candidates = await tx.execute<{ id: string }>(sql`
      select id from jobs
      where status in ('pending', 'retrying', 'running')
        and run_at <= ${now}
        and (locked_until is null or locked_until < ${now})
      order by run_at
      limit ${limit}
      for update skip locked
    `);
    const ids = rowsOf<{ id: string }>(candidates).map((r) => r.id);
    if (ids.length === 0) return [];

    return tx
      .update(schema.jobs)
      .set({ status: "running", lockedUntil, updatedAt: now })
      .where(inArray(schema.jobs.id, ids))
      .returning();
  });
}

export interface OutcomeOptions {
  durationMs: number;
  httpStatus?: number;
  error?: string;
  /** Only meaningful when outcome is "retrying". */
  nextRunAt?: Date;
}

/**
 * Records the result of one attempt: updates the job row's status/attempts
 * and appends a row to job_attempts, in one transaction, so the dashboard's
 * attempt history and the job's current status never disagree.
 */
export async function recordOutcome(
  db: Database,
  job: JobRow,
  outcome: "succeeded" | "retrying" | "dead",
  opts: OutcomeOptions,
): Promise<void> {
  const attemptNumber = job.attempts + 1;
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx
      .update(schema.jobs)
      .set({
        status: outcome,
        attempts: attemptNumber,
        lockedUntil: null,
        runAt: outcome === "retrying" ? (opts.nextRunAt ?? now) : job.runAt,
        lastError: opts.error ?? null,
        updatedAt: now,
      })
      .where(eq(schema.jobs.id, job.id));

    await tx.insert(schema.jobAttempts).values({
      jobId: job.id,
      attemptNumber,
      outcome,
      httpStatus: opts.httpStatus,
      durationMs: opts.durationMs,
      error: opts.error,
    });
  });
}
