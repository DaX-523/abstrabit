import { schema, type Queryable } from "@/db";
import {
  ephemeralMessage,
  getInteractionUser,
  getStringOption,
  InteractionResponseType,
  EPHEMERAL_FLAG,
  type Interaction,
} from "@/lib/discord/types";
import type { CommandPlan } from "./types";

/** Interaction tokens are only valid for 15 minutes; give jobs that use one
 * a hard stop a little before that so they dead-letter cleanly instead of
 * burning retries on a token that's already expired. */
const TOKEN_LIFETIME_MS = 14.5 * 60 * 1000;

export async function planReport(
  tx: Queryable,
  interaction: Interaction,
  interactionId: string,
): Promise<CommandPlan> {
  const text = getStringOption(interaction, "text")?.trim();
  const guildId = interaction.guild_id;
  const user = getInteractionUser(interaction);

  if (!guildId) {
    return { response: ephemeralMessage("This command only works inside a server."), jobs: [] };
  }
  if (!user) {
    return { response: ephemeralMessage("Couldn't identify who ran this command."), jobs: [] };
  }
  if (!text) {
    // The modal stretch goal (opening a dialog for title + details) hooks in
    // here once built; for now, require the inline text argument.
    return {
      response: ephemeralMessage("Please include some text, e.g. `/report the printer is on fire`."),
      jobs: [],
    };
  }

  // A guild can run /report before any admin has gone through the dashboard's
  // "connect a server" OAuth flow, so the guilds row this report's FK needs
  // may not exist yet -- auto-create a placeholder rather than fail. The
  // OAuth connect flow (upserting the real name/channel/mirror) overwrites
  // it once an admin does connect.
  await tx
    .insert(schema.guilds)
    .values({ id: guildId, name: `Unknown server (${guildId})` })
    .onConflictDoNothing({ target: schema.guilds.id });

  const reportId = crypto.randomUUID();
  await tx.insert(schema.reports).values({
    id: reportId,
    guildId,
    interactionId,
    authorId: user.id,
    authorUsername: user.username,
    body: text,
    priority: "medium",
    status: "open",
  });

  const guild = await tx.query.guilds.findFirst({ where: (g, { eq }) => eq(g.id, guildId) });
  const tokenExpiresAt = new Date(Date.now() + TOKEN_LIFETIME_MS);

  const jobs: CommandPlan["jobs"] = [];
  if (guild?.reportChannelId) {
    jobs.push({
      kind: "channel_post",
      payload: { reportId, guildId, channelId: guild.reportChannelId },
      deadline: tokenExpiresAt,
    });
  }
  if (guild?.mirrorUrlEnc) {
    jobs.push({
      kind: "mirror",
      payload: { reportId, guildId },
      deadline: tokenExpiresAt,
    });
  }
  // Always acknowledge the user, even if this guild has no channel/mirror
  // configured yet -- the report is still recorded and visible on the
  // dashboard either way.
  jobs.push({
    kind: "reply",
    payload: {
      reportId,
      applicationId: interaction.application_id,
      interactionToken: interaction.token,
    },
    deadline: tokenExpiresAt,
  });

  return {
    response: {
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: EPHEMERAL_FLAG },
    },
    jobs,
  };
}
