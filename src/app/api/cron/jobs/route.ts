import { NextRequest, NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { getDb } from "@/db";
import { runDueJobs } from "@/lib/jobs/runner";
import { handlers } from "@/lib/jobs/handlers";
import { log } from "@/lib/log";

export const runtime = "nodejs";
// Never cache/prerender a cron endpoint's response.
export const dynamic = "force-dynamic";

/**
 * Hit once a minute by cron-job.org (Vercel Hobby's own cron can only run
 * once a day, so it's used only as a daily backstop -- see README). Also
 * effectively what `after()` in the interactions route calls immediately
 * after responding, so most jobs actually run within a second or two, not a
 * full minute later; this endpoint exists to retry anything that failed or
 * that `after()` didn't get to before the function instance was recycled.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const env = getEnv();
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${env.CRON_SECRET}`) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  try {
    const db = getDb();
    const { processed } = await runDueJobs(db, handlers, { limit: 25 });
    return NextResponse.json({ processed });
  } catch (err) {
    log.error("cron sweep failed", { error: err instanceof Error ? err.message : String(err) });
    return new NextResponse("internal error", { status: 500 });
  }
}
