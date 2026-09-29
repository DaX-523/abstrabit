import { and, eq, gte, sql } from "drizzle-orm";
import { schema, type Queryable } from "@/db";
import { ephemeralMessage, getInteractionUser, type Interaction } from "@/lib/discord/types";
import type { CommandPlan } from "./types";

export async function planStatus(tx: Queryable, interaction: Interaction): Promise<CommandPlan> {
  const guildId = interaction.guild_id;
  if (!guildId) {
    return { response: ephemeralMessage("This command only works inside a server."), jobs: [] };
  }

  const guild = await tx.query.guilds.findFirst({ where: (g, { eq }) => eq(g.id, guildId) });
  // "Connected" means an admin has picked a report channel via the
  // dashboard's OAuth flow -- not merely that a guilds row exists, since
  // /report auto-creates a placeholder row for any server it's run in.
  if (!guild?.reportChannelId) {
    return {
      response: ephemeralMessage(
        "This server isn't connected to the dashboard yet. Ask an admin to connect it first.",
      ),
      jobs: [],
    };
  }

  const user = getInteractionUser(interaction);

  const [[openRow], [deadJobsRow], recent] = await Promise.all([
    tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.reports)
      .where(and(eq(schema.reports.guildId, guildId), eq(schema.reports.status, "open"))),
    tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.jobs)
      .innerJoin(schema.interactions, eq(schema.jobs.interactionId, schema.interactions.id))
      .where(
        and(
          eq(schema.jobs.status, "dead"),
          eq(schema.interactions.guildId, guildId),
          gte(schema.jobs.updatedAt, new Date(Date.now() - 24 * 60 * 60 * 1000)),
        ),
      ),
    user
      ? tx.query.reports.findMany({
          where: (r, { eq, and }) => and(eq(r.guildId, guildId), eq(r.authorId, user.id)),
          orderBy: (r, { desc }) => desc(r.createdAt),
          limit: 3,
        })
      : Promise.resolve([]),
  ]);

  const lines = [
    `**Connected** — reports post to ${guild.reportChannelId ? `<#${guild.reportChannelId}>` : "*(no channel set)*"}`,
    `Mirror: ${guild.mirrorKind === "none" ? "*not configured*" : guild.mirrorKind}`,
    `Open reports: ${openRow?.count ?? 0}`,
  ];
  if (deadJobsRow?.count) {
    lines.push(`⚠️ ${deadJobsRow.count} failed action(s) in the last 24h — an admin can retry them on the dashboard.`);
  }
  if (recent.length > 0) {
    lines.push(
      `Your recent reports: ${recent.map((r) => `“${r.body.slice(0, 40)}${r.body.length > 40 ? "…" : ""}” (${r.status})`).join("; ")}`,
    );
  } else {
    lines.push("You haven't filed any reports yet.");
  }

  return { response: ephemeralMessage(lines.join("\n")), jobs: [] };
}
