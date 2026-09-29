import { getDb } from "@/db";
import { decrypt } from "@/lib/crypto";
import { sendMirror } from "@/lib/mirror";
import { PermanentError, type JobHandler } from "@/lib/jobs/runner";

interface MirrorPayload {
  reportId: string;
  guildId: string;
}

function isMirrorPayload(value: unknown): value is MirrorPayload {
  const v = value as Partial<MirrorPayload> | null;
  return !!v && typeof v.reportId === "string" && typeof v.guildId === "string";
}

/** Sends a copy of the report to the guild's configured second channel (Slack or Discord webhook). */
export const mirrorHandler: JobHandler = async (payload) => {
  if (!isMirrorPayload(payload)) throw new Error("mirror job payload is malformed");
  const db = getDb();
  const [report, guild] = await Promise.all([
    db.query.reports.findFirst({ where: (r, { eq }) => eq(r.id, payload.reportId) }),
    db.query.guilds.findFirst({ where: (g, { eq }) => eq(g.id, payload.guildId) }),
  ]);

  if (!report) throw new PermanentError(`report ${payload.reportId} not found`);
  if (!guild?.mirrorUrlEnc) throw new PermanentError(`guild ${payload.guildId} has no mirror configured`);

  const url = decrypt(guild.mirrorUrlEnc);
  await sendMirror(url, {
    title: `New report in ${guild.name}`,
    lines: [
      `Priority: ${report.priority}`,
      `From: ${report.authorUsername ?? report.authorId}`,
      report.body.slice(0, 500),
    ],
  });
};
