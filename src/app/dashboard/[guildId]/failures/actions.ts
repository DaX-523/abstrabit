"use server";

import { after } from "next/server";
import { getDb } from "@/db";
import { handlers } from "@/lib/jobs/handlers";
import { retryJob } from "@/lib/jobs/retry";
import { runDueJobs } from "@/lib/jobs/runner";
import { log } from "@/lib/log";
import { guardedGuildId, redirectWithMessage } from "../guard";

function back(guildId: string, key: "success" | "error", message: string): never {
  redirectWithMessage(`/dashboard/${guildId}/failures`, key, message);
}

const FAILURE_MESSAGES = {
  not_found: "That action wasn't found on this server.",
  not_failed: "That action isn't failed any more, so there's nothing to retry. Refresh the page.",
  token_expired:
    "The reply can't be retried: Discord's 15-minute window for answering that command has passed. The report itself was recorded.",
} as const;

export async function retryJobAction(formData: FormData): Promise<void> {
  const guildId = await guardedGuildId(formData);
  const jobId = String(formData.get("jobId") ?? "");

  const result = await retryJob(getDb(), guildId, jobId);
  if (!result.ok) back(guildId, "error", FAILURE_MESSAGES[result.reason]);

  // "Retry now" should mean now: run it right after responding rather than
  // waiting for the next cron sweep.
  after(async () => {
    try {
      await runDueJobs(getDb(), handlers, { limit: 10 });
    } catch (err) {
      log.error("post-retry job run failed", { error: err instanceof Error ? err.message : String(err) });
    }
  });

  back(guildId, "success", `Retrying the ${result.kind.replace("_", " ")} now. Refresh in a few seconds to see the result.`);
}
