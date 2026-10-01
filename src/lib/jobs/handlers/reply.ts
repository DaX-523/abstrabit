import { getDb } from "@/db";
import { patchOriginalResponse } from "@/lib/discord/api";
import type { JobHandler } from "@/lib/jobs/runner";

interface ReplyPayload {
  reportId: string;
  applicationId: string;
  interactionToken: string;
  /** Rule-configured lines appended to the confirmation. */
  notes?: string[];
}

function isReplyPayload(value: unknown): value is ReplyPayload {
  const v = value as Partial<ReplyPayload> | null;
  return (
    !!v &&
    typeof v.reportId === "string" &&
    typeof v.applicationId === "string" &&
    typeof v.interactionToken === "string" &&
    (v.notes === undefined || (Array.isArray(v.notes) && v.notes.every((n) => typeof n === "string")))
  );
}

/** PATCHes the deferred interaction's @original message with the final result. */
export const replyHandler: JobHandler = async (payload) => {
  if (!isReplyPayload(payload)) throw new Error("reply job payload is malformed");
  const db = getDb();
  const report = await db.query.reports.findFirst({ where: (r, { eq }) => eq(r.id, payload.reportId) });

  const confirmation = report
    ? `✅ Report recorded (priority: **${report.priority}**). Thanks for flagging it.`
    : "✅ Recorded, though the report detail couldn't be found when replying.";
  // Discord caps message content at 2000 characters.
  const content = [confirmation, ...(payload.notes ?? [])].join("\n").slice(0, 1900);

  await patchOriginalResponse(payload.applicationId, payload.interactionToken, {
    content,
    allowed_mentions: { parse: [] },
  });
};
