import type { HandlerRegistry } from "@/lib/jobs/runner";

/**
 * The live handler registry, wired up incrementally as each job kind's real
 * logic lands (reply/channel_post/mirror in the core /report pipeline,
 * triage/ai_enrich with the AI stretch goal, status_followup for /status).
 * Empty for now -- any job claimed before a kind's handler exists is
 * correctly dead-lettered by the runner rather than silently dropped.
 */
export const handlers: HandlerRegistry = {};
