import type { JobKind } from "@/lib/jobs/queue";
import type { InteractionResponseBody } from "@/lib/discord/types";

export interface JobSpec {
  kind: JobKind;
  payload: unknown;
  deadline?: Date;
  maxAttempts?: number;
}

/** What handling one (new, non-duplicate) interaction produces: the response
 * to send Discord right now, and the background jobs to enqueue alongside it. */
export interface CommandPlan {
  response: InteractionResponseBody;
  jobs: JobSpec[];
  /** Which configured rules matched, stored on the interaction for the dashboard's log. */
  ruleMatches?: Array<{ id: string; summary: string }>;
}
