import type { Database } from "@/db";
import { decrypt } from "@/lib/crypto";
import { log } from "@/lib/log";
import { claimDueJobs, recordOutcome, type ClaimOptions, type JobKind, type JobRow } from "./queue";
import { computeBackoffMs } from "./backoff";

/** Thrown by a handler for a failure worth retrying (network error, 5xx, 429). */
export class RetryableError extends Error {
  readonly retryAfterMs?: number;
  readonly httpStatus?: number;
  constructor(message: string, opts: { retryAfterMs?: number; httpStatus?: number } = {}) {
    super(message);
    this.name = "RetryableError";
    this.retryAfterMs = opts.retryAfterMs;
    this.httpStatus = opts.httpStatus;
  }
}

/** Thrown by a handler for a failure that will never succeed on retry (404, 401, bad config). */
export class PermanentError extends Error {
  readonly httpStatus?: number;
  constructor(message: string, opts: { httpStatus?: number } = {}) {
    super(message);
    this.name = "PermanentError";
    this.httpStatus = opts.httpStatus;
  }
}

export type JobHandler<P = unknown> = (payload: P, ctx: { job: JobRow }) => Promise<void>;
export type HandlerRegistry = Partial<Record<JobKind, JobHandler>>;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function httpStatusOf(err: unknown): number | undefined {
  if (err instanceof RetryableError || err instanceof PermanentError) return err.httpStatus;
  return undefined;
}

/**
 * Runs a single claimed job through its handler and writes the outcome.
 * Never throws -- a handler bug or an unexpected rejection is treated as a
 * (by default retryable) failure and recorded, not left to crash the sweep.
 */
export async function processJob(
  db: Database,
  job: JobRow,
  handlers: HandlerRegistry,
): Promise<void> {
  const startedAt = Date.now();
  const attemptNumber = job.attempts + 1;

  const handler = handlers[job.kind];
  if (!handler) {
    await recordOutcome(db, job, "dead", {
      durationMs: 0,
      error: `no handler registered for job kind "${job.kind}"`,
    });
    return;
  }

  const pastDeadline = job.deadline !== null && job.deadline.getTime() < Date.now();
  if (pastDeadline) {
    await recordOutcome(db, job, "dead", { durationMs: 0, error: "deadline exceeded before attempt" });
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(decrypt(job.payloadEnc));
  } catch (err) {
    await recordOutcome(db, job, "dead", {
      durationMs: 0,
      error: `failed to decrypt/parse job payload: ${errorMessage(err)}`,
    });
    return;
  }

  try {
    await handler(payload, { job });
    await recordOutcome(db, job, "succeeded", { durationMs: Date.now() - startedAt });
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const nowPastDeadline = job.deadline !== null && job.deadline.getTime() < Date.now();
    const isPermanent = err instanceof PermanentError;
    const outOfAttempts = attemptNumber >= job.maxAttempts;

    if (isPermanent || outOfAttempts || nowPastDeadline) {
      await recordOutcome(db, job, "dead", {
        durationMs,
        httpStatus: httpStatusOf(err),
        error: nowPastDeadline ? "deadline exceeded during attempt" : errorMessage(err),
      });
      log.warn("job dead-lettered", {
        jobId: job.id,
        kind: job.kind,
        interactionId: job.interactionId,
        reason: nowPastDeadline ? "deadline" : isPermanent ? "permanent-error" : "out-of-attempts",
      });
      return;
    }

    const backoffMs =
      err instanceof RetryableError && err.retryAfterMs !== undefined
        ? err.retryAfterMs
        : computeBackoffMs(attemptNumber);

    await recordOutcome(db, job, "retrying", {
      durationMs,
      httpStatus: httpStatusOf(err),
      error: errorMessage(err),
      nextRunAt: new Date(Date.now() + backoffMs),
    });
  }
}

/**
 * Claims and runs a batch of due jobs. This is what both the cron sweeper
 * route and `after()` in the interactions route call. Jobs run sequentially
 * within a batch to keep this simple and avoid surprising concurrency on a
 * single interaction's dependent jobs (e.g. `reply` after `triage`).
 */
export async function runDueJobs(
  db: Database,
  handlers: HandlerRegistry,
  opts: ClaimOptions = {},
): Promise<{ processed: number }> {
  const claimed = await claimDueJobs(db, opts);
  for (const job of claimed) {
    await processJob(db, job, handlers);
  }
  return { processed: claimed.length };
}
