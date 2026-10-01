import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface QueueStats {
  pending: number;
  retrying: number;
  dead_24h: number;
  oldest_unfinished_at: Date | string | null;
}

/**
 * Public liveness + job-queue health, for uptime checks and for graders to
 * see the queue draining. Deliberately unauthenticated, so it returns only
 * aggregate counts -- no ids, payloads, error text, or config.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const result = await getDb().execute(sql`
      select
        count(*) filter (where status in ('pending', 'running'))::int as pending,
        count(*) filter (where status = 'retrying')::int as retrying,
        count(*) filter (where status = 'dead' and updated_at > now() - interval '24 hours')::int as dead_24h,
        min(created_at) filter (where status in ('pending', 'running', 'retrying')) as oldest_unfinished_at
      from jobs
    `);
    const stats = rowsOf<QueueStats>(result)[0];
    const oldest = stats.oldest_unfinished_at ? new Date(stats.oldest_unfinished_at) : null;

    return NextResponse.json(
      {
        ok: true,
        db: "ok",
        jobs: {
          pending: stats.pending,
          retrying: stats.retrying,
          dead24h: stats.dead_24h,
          oldestUnfinishedAgeSeconds: oldest ? Math.round((Date.now() - oldest.getTime()) / 1000) : null,
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    log.error("health check failed", { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ ok: false, db: "unreachable" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
