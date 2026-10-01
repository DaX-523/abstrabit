import "server-only";
import { schema, type Database } from "@/db";

export interface FeedJob {
  id: string;
  kind: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  runAt: string;
}

export interface FeedItem {
  id: string;
  type: number;
  command: string | null;
  customId: string | null;
  userId: string | null;
  username: string | null;
  status: string;
  duplicateCount: number;
  createdAt: string;
  /** Summaries of the configured rules that matched this command, if any. */
  ruleMatches: string[];
  jobs: FeedJob[];
}

const DEFAULT_LIMIT = 50;

/** `interactions.rule_matches` is untrusted-shape jsonb; keep only well-formed summaries. */
function ruleMatchSummaries(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((m) =>
    typeof m === "object" && m !== null && typeof (m as { summary?: unknown }).summary === "string"
      ? [(m as { summary: string }).summary]
      : [],
  );
}

/**
 * The live log's data source, shared by the dashboard page's initial
 * server-rendered load and the polling API route so the two never drift
 * out of sync in shape. `after` (an ISO timestamp) returns only interactions
 * created after it, oldest-first, for incremental polling; omitted, it
 * returns the most recent `limit` interactions.
 */
export async function getRecentInteractions(
  db: Database,
  guildId: string,
  opts: { after?: Date; limit?: number } = {},
): Promise<FeedItem[]> {
  const limit = opts.limit ?? DEFAULT_LIMIT;

  const rows = await db.query.interactions.findMany({
    where: (i, { eq, and, gt }) =>
      opts.after ? and(eq(i.guildId, guildId), gt(i.createdAt, opts.after)) : eq(i.guildId, guildId),
    orderBy: opts.after ? (i, { asc }) => asc(i.createdAt) : (i, { desc }) => desc(i.createdAt),
    limit,
    with: { jobs: true },
  });

  // Always hand back oldest-first so the client can append to a
  // growing-downward list regardless of which branch above ran.
  const ordered = opts.after ? rows : [...rows].reverse();

  return ordered.map((row) => ({
    id: row.id,
    type: row.type,
    command: row.command,
    customId: row.customId,
    userId: row.userId,
    username: row.username,
    status: row.status,
    duplicateCount: row.duplicateCount,
    createdAt: row.createdAt.toISOString(),
    ruleMatches: ruleMatchSummaries(row.ruleMatches),
    jobs: row.jobs
      .slice()
      .sort((a: typeof schema.jobs.$inferSelect, b: typeof schema.jobs.$inferSelect) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((j: typeof schema.jobs.$inferSelect) => ({
        id: j.id,
        kind: j.kind,
        status: j.status,
        attempts: j.attempts,
        maxAttempts: j.maxAttempts,
        lastError: j.lastError,
        runAt: j.runAt.toISOString(),
      })),
  }));
}
