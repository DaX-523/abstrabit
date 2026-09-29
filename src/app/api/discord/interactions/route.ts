import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { getEnv } from "@/lib/env";
import { verifyDiscordSignature } from "@/lib/discord/verify";
import { log } from "@/lib/log";
import { getDb } from "@/db";
import { handleInteraction } from "@/lib/interactions/handle";
import { InteractionType } from "@/lib/discord/types";
import { runDueJobs } from "@/lib/jobs/runner";
import { handlers } from "@/lib/jobs/handlers";

// Ed25519 verification and the DB client both need Node APIs; this route
// must not run on the Edge runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Discord's own interaction payloads are small; refuse anything absurd
// before it hits JSON.parse or the DB. (Vercel's own 4.5MB body limit still
// applies underneath this.)
const MAX_BODY_BYTES = 1_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    return new NextResponse("payload too large", { status: 413 });
  }

  // Read the raw body ONCE, as text, before any parsing -- signature
  // verification runs over these exact bytes.
  const rawBody = await req.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    return new NextResponse("payload too large", { status: 413 });
  }

  const signature = req.headers.get("x-signature-ed25519");
  const timestamp = req.headers.get("x-signature-timestamp");

  const env = getEnv();
  const verification = verifyDiscordSignature({
    rawBody,
    signature,
    timestamp,
    publicKey: env.DISCORD_PUBLIC_KEY,
  });

  if (!verification.ok) {
    log.warn("rejected interaction: signature verification failed", {
      reason: verification.reason,
    });
    return new NextResponse("invalid request signature", { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new NextResponse("invalid json body", { status: 400 });
  }

  if (!isRecord(payload) || typeof payload.type !== "number") {
    return new NextResponse("invalid interaction payload", { status: 400 });
  }

  if (payload.type === InteractionType.PING) {
    return NextResponse.json({ type: 1 });
  }

  const responseBody = await handleInteraction(getDb(), payload);

  // Run any jobs this interaction just enqueued right away, after the
  // response has been sent -- most users see the channel post / mirror /
  // final reply within a second or two rather than waiting for the next
  // cron sweep. The cron sweep (POST /api/cron/jobs) is what guarantees
  // eventual delivery if this never runs (function recycled, brief crash).
  after(async () => {
    try {
      await runDueJobs(getDb(), handlers, { limit: 10 });
    } catch (err) {
      log.error("post-response job run failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return NextResponse.json(responseBody);
}
