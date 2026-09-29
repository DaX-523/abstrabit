import { NextRequest, NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { verifyDiscordSignature } from "@/lib/discord/verify";
import { log } from "@/lib/log";

// Ed25519 verification and the DB client both need Node APIs; this route
// must not run on the Edge runtime.
export const runtime = "nodejs";

// Discord's own interaction payloads are small; refuse anything absurd
// before it hits JSON.parse or the DB. (Vercel's own 4.5MB body limit still
// applies underneath this.)
const MAX_BODY_BYTES = 1_000_000;

const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  MODAL_SUBMIT: 5,
} as const;

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

  // Command/component/modal handling is wired up in a later step (once the
  // job queue and dedup-on-interaction-id logic land). Until then, respond
  // with a real Discord interaction response type rather than an error, so
  // Discord doesn't flag the endpoint as broken during development.
  log.info("received interaction (handler not yet implemented)", {
    type: payload.type,
    id: typeof payload.id === "string" ? payload.id : undefined,
  });
  return NextResponse.json({
    type: 4,
    data: { content: "This command isn't wired up yet.", flags: 64 },
  });
}
