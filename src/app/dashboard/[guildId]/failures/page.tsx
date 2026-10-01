import { redirect, notFound } from "next/navigation";
import { and, desc, eq, gt, inArray, or } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { requireGuildAdmin, AuthError } from "@/lib/auth";
import { GuildHeader } from "@/components/GuildHeader";
import { SubmitButton } from "@/components/SubmitButton";
import { retryJobAction } from "./actions";

export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<string, string> = {
  dead: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
  retrying: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  succeeded: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200",
  pending: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
  running: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
};

const STATUS_LABEL: Record<string, string> = {
  dead: "gave up",
  retrying: "retrying",
  succeeded: "recovered",
  pending: "queued",
  running: "running",
};

function fmt(date: Date): string {
  return date.toLocaleString();
}

function hasPassed(date: Date | null): boolean {
  return !date || date.getTime() <= Date.now();
}

export default async function FailuresPage({
  params,
  searchParams,
}: {
  params: Promise<{ guildId: string }>;
  searchParams: Promise<{ success?: string; error?: string }>;
}) {
  const { guildId } = await params;
  const { success, error } = await searchParams;
  const db = getDb();

  try {
    await requireGuildAdmin(db, guildId);
  } catch (err) {
    if (err instanceof AuthError) redirect("/login");
    throw err;
  }

  const guild = await db.query.guilds.findFirst({ where: (g, { eq }) => eq(g.id, guildId) });
  if (!guild) notFound();

  // This server's jobs only (joined through the interaction's guild), that
  // are failing now or needed more than one try -- retrying, gave up, or
  // "recovered" (succeeded after at least one failed attempt).
  const jobs = await db
    .select({
      job: schema.jobs,
      command: schema.interactions.command,
      customId: schema.interactions.customId,
      username: schema.interactions.username,
    })
    .from(schema.jobs)
    .innerJoin(schema.interactions, eq(schema.jobs.interactionId, schema.interactions.id))
    .where(
      and(
        eq(schema.interactions.guildId, guildId),
        or(
          inArray(schema.jobs.status, ["retrying", "dead"]),
          and(eq(schema.jobs.status, "succeeded"), gt(schema.jobs.attempts, 1)),
        ),
      ),
    )
    .orderBy(desc(schema.jobs.updatedAt))
    .limit(50);

  const attempts =
    jobs.length === 0
      ? []
      : await db.query.jobAttempts.findMany({
          where: (a, { inArray }) =>
            inArray(
              a.jobId,
              jobs.map((j) => j.job.id),
            ),
          orderBy: (a, { asc }) => asc(a.attemptNumber),
        });

  const dead = jobs.filter((j) => j.job.status === "dead").length;
  const retrying = jobs.filter((j) => j.job.status === "retrying").length;

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-4 py-10">
      <GuildHeader guildId={guildId} name={guild.name} active="failures" />

      {success && (
        <p role="status" className="alert-success">
          {success}
        </p>
      )}
      {error && (
        <p role="alert" className="alert-error">
          {error}
        </p>
      )}

      <p className="text-sm text-muted">
        Replies, channel posts and mirror notices that failed or needed more than one try. Temporary errors (network,
        rate limits, 5xx) retry automatically with backoff; permanent ones (like a deleted webhook) stop here with the
        reason.{" "}
        {jobs.length > 0 && (
          <span className="font-medium text-foreground">
            {dead} gave up · {retrying} retrying
          </span>
        )}
      </p>

      {jobs.length === 0 ? (
        <div className="card text-sm text-muted">
          Nothing has failed. If a mirror, channel post or reply ever does, it shows up here with every attempt.
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {jobs.map(({ job, command, customId, username }) => {
            const history = attempts.filter((a) => a.jobId === job.id);
            const failed = job.status === "dead" || job.status === "retrying";
            const tokenExpired = job.kind === "reply" && hasPassed(job.deadline);
            return (
              <li key={job.id} className="card flex flex-col gap-3 p-4 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono font-medium">{job.kind}</span>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[job.status] ?? ""}`}>
                      {STATUS_LABEL[job.status] ?? job.status}
                    </span>
                    <span className="text-xs text-muted">
                      attempt {job.attempts}/{job.maxAttempts}
                    </span>
                  </div>
                  <span className="text-xs text-muted">{fmt(job.updatedAt)}</span>
                </div>

                <p className="text-xs text-muted">
                  From {command ? `/${command}` : `${customId ?? "an interaction"}`} by {username ?? "unknown user"}
                </p>

                {job.lastError && job.status !== "succeeded" && (
                  <p className="rounded-lg bg-red-50 px-3 py-2 font-mono text-xs text-red-800 dark:bg-red-950 dark:text-red-200">
                    {job.lastError}
                  </p>
                )}
                {job.status === "retrying" && (
                  <p className="text-xs text-muted">Next automatic try: {fmt(job.runAt)}</p>
                )}

                {history.length > 0 && (
                  <details className="text-xs">
                    <summary className="text-muted">Attempt history ({history.length})</summary>
                    <ul className="mt-2 flex flex-col gap-1 border-l-2 border-border pl-3">
                      {history.map((a) => (
                        <li key={a.id}>
                          <span className="font-mono">#{a.attemptNumber}</span> {a.outcome}
                          {a.httpStatus ? ` · HTTP ${a.httpStatus}` : ""}
                          {a.durationMs !== null ? ` · ${a.durationMs} ms` : ""} · {fmt(a.createdAt)}
                          {a.error && <span className="text-red-700 dark:text-red-300"> · {a.error}</span>}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}

                {failed &&
                  (tokenExpired ? (
                    <p className="text-xs text-muted">
                      Can&apos;t be retried: Discord only lets the bot answer a command for 15 minutes. The report was
                      still recorded.
                    </p>
                  ) : (
                    <form action={retryJobAction}>
                      <input type="hidden" name="guildId" value={guildId} />
                      <input type="hidden" name="jobId" value={job.id} />
                      <SubmitButton small pendingText="Retrying…">
                        Retry now
                      </SubmitButton>
                    </form>
                  ))}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
