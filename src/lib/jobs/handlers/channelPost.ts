import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { postChannelMessage } from "@/lib/discord/api";
import { PermanentError, type JobHandler } from "@/lib/jobs/runner";

interface ChannelPostPayload {
  reportId: string;
  guildId: string;
  channelId: string;
}

function isChannelPostPayload(value: unknown): value is ChannelPostPayload {
  const v = value as Partial<ChannelPostPayload> | null;
  return !!v && typeof v.reportId === "string" && typeof v.guildId === "string" && typeof v.channelId === "string";
}

const PRIORITY_COLOR: Record<string, number> = {
  low: 0x57f287,
  medium: 0x5865f2,
  high: 0xfee75c,
  critical: 0xed4245,
};

/** Posts the report as an embed in the guild's configured report channel. */
export const channelPostHandler: JobHandler = async (payload) => {
  if (!isChannelPostPayload(payload)) throw new Error("channel_post job payload is malformed");
  const db = getDb();
  const report = await db.query.reports.findFirst({ where: (r, { eq }) => eq(r.id, payload.reportId) });
  if (!report) {
    throw new PermanentError(`report ${payload.reportId} not found`);
  }

  const embed = {
    title: "New report",
    description: report.body.slice(0, 4000),
    color: PRIORITY_COLOR[report.priority] ?? PRIORITY_COLOR.medium,
    fields: [
      { name: "Priority", value: report.priority, inline: true },
      { name: "Author", value: report.authorUsername ?? report.authorId, inline: true },
      { name: "Status", value: report.status, inline: true },
    ],
    timestamp: report.createdAt.toISOString(),
  };

  // Buttons (Acknowledge/Resolve) attach here once that stretch goal lands.
  const message = await postChannelMessage(payload.channelId, {
    embeds: [embed],
    allowed_mentions: { parse: [] },
  });

  await db
    .update(schema.reports)
    .set({ channelId: payload.channelId, messageId: message.id, updatedAt: new Date() })
    .where(eq(schema.reports.id, payload.reportId));
};
