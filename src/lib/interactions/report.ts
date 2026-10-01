import { and, eq, gte, sql } from "drizzle-orm";
import { schema, type Queryable } from "@/db";
import {
  ephemeralMessage,
  getInteractionUser,
  getStringOption,
  InteractionResponseType,
  InteractionType,
  EPHEMERAL_FLAG,
  type Interaction,
  type InteractionResponseBody,
} from "@/lib/discord/types";
import { getCommandConfig } from "@/lib/commandConfig";
import { evaluateRules } from "@/lib/rules";
import type { CommandPlan } from "./types";

/** Interaction tokens are only valid for 15 minutes; give jobs that use one
 * a hard stop a little before that so they dead-letter cleanly instead of
 * burning retries on a token that's already expired. */
const TOKEN_LIFETIME_MS = 14.5 * 60 * 1000;

/** Channel posts and mirrors don't use the token, so they keep retrying for a
 * day: an outage of a few hours shouldn't lose a report's notification. */
const DELIVERY_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

export const REPORT_MODAL_ID = "report_modal";
const MAX_TITLE_LENGTH = 100;
const MAX_BODY_LENGTH = 4000;

/** The dialog `/report` opens when run without text (if the server has that enabled). */
export function reportModal(): InteractionResponseBody {
  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: REPORT_MODAL_ID,
      title: "File a report",
      components: [
        {
          type: 1, // action row
          components: [
            {
              type: 4, // text input
              custom_id: "title",
              style: 1, // short
              label: "Title",
              min_length: 1,
              max_length: MAX_TITLE_LENGTH,
              required: true,
              placeholder: "e.g. Checkout page is down",
            },
          ],
        },
        {
          type: 1,
          components: [
            {
              type: 4,
              custom_id: "details",
              style: 2, // paragraph
              label: "Details",
              min_length: 1,
              max_length: 1000,
              required: true,
              placeholder: "What happened? Include anything that helps.",
            },
          ],
        },
      ],
    },
  };
}

export interface ReportInput {
  /** From the modal's title field; absent for `/report <text>`. */
  title?: string;
  /** The report text: the slash option, or the modal's details field. */
  text?: string;
}

export async function planReport(
  tx: Queryable,
  interaction: Interaction,
  interactionId: string,
  input: ReportInput = {},
): Promise<CommandPlan> {
  const guildId = interaction.guild_id;
  const user = getInteractionUser(interaction);

  if (!guildId) {
    return { response: ephemeralMessage("This command only works inside a server."), jobs: [] };
  }
  if (!user) {
    return { response: ephemeralMessage("Couldn't identify who ran this command."), jobs: [] };
  }

  const config = await getCommandConfig(tx, guildId, "report");
  if (!config.enabled) {
    return { response: ephemeralMessage("/report is turned off on this server."), jobs: [] };
  }

  const text = (input.text ?? getStringOption(interaction, "text"))?.trim().slice(0, MAX_BODY_LENGTH);
  const title = input.title?.trim().slice(0, MAX_TITLE_LENGTH) || undefined;

  if (!text) {
    if (config.modalWhenEmpty && interaction.type === InteractionType.APPLICATION_COMMAND) {
      return { response: reportModal(), jobs: [] };
    }
    return {
      response: ephemeralMessage("Please include some text, e.g. `/report the printer is on fire`."),
      jobs: [],
    };
  }

  if (config.cooldownCount > 0) {
    const since = new Date(Date.now() - config.cooldownWindowSeconds * 1000);
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.reports)
      .where(
        and(
          eq(schema.reports.guildId, guildId),
          eq(schema.reports.authorId, user.id),
          gte(schema.reports.createdAt, since),
        ),
      );
    if (count >= config.cooldownCount) {
      return {
        response: ephemeralMessage(
          `You've filed ${count} report(s) in the last ${config.cooldownWindowSeconds}s — this server allows ` +
            `${config.cooldownCount}. Please wait a moment and try again.`,
        ),
        jobs: [],
      };
    }
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

  const rules = await tx.query.rules.findMany({
    where: (r, { and, eq }) => and(eq(r.guildId, guildId), eq(r.command, "report")),
  });
  const outcome = evaluateRules(rules, [title, text].filter(Boolean).join("\n"));

  const reportId = crypto.randomUUID();
  await tx.insert(schema.reports).values({
    id: reportId,
    guildId,
    interactionId,
    authorId: user.id,
    authorUsername: user.username,
    title,
    body: text,
    priority: outcome.priority,
    status: "open",
  });

  const guild = await tx.query.guilds.findFirst({ where: (g, { eq }) => eq(g.id, guildId) });
  const now = Date.now();
  const tokenExpiresAt = new Date(now + TOKEN_LIFETIME_MS);
  const deliveryDeadline = new Date(now + DELIVERY_RETRY_WINDOW_MS);

  const jobs: CommandPlan["jobs"] = [];
  if (config.postToChannel && guild?.reportChannelId) {
    jobs.push({
      kind: "channel_post",
      payload: { reportId, guildId, channelId: guild.reportChannelId },
      deadline: deliveryDeadline,
    });
  }
  if (config.mirror && !outcome.skipMirror && guild?.mirrorUrlEnc) {
    jobs.push({
      kind: "mirror",
      payload: { reportId, guildId },
      deadline: deliveryDeadline,
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
      notes: outcome.notes,
    },
    deadline: tokenExpiresAt,
  });

  return {
    response: {
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: config.ephemeral ? { flags: EPHEMERAL_FLAG } : {},
    },
    jobs,
    ruleMatches: outcome.matched,
  };
}
