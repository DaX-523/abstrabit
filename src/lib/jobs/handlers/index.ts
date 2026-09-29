import type { HandlerRegistry } from "@/lib/jobs/runner";
import { replyHandler } from "./reply";
import { channelPostHandler } from "./channelPost";
import { mirrorHandler } from "./mirror";

/**
 * The live handler registry. `triage` and `ai_enrich` (AI stretch goal) and
 * `status_followup` are wired up in later steps; any job of a kind with no
 * handler here is correctly dead-lettered by the runner rather than
 * silently dropped (see runner.ts).
 */
export const handlers: HandlerRegistry = {
  reply: replyHandler,
  channel_post: channelPostHandler,
  mirror: mirrorHandler,
};
