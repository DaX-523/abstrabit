import { eq, sql } from "drizzle-orm";
import { schema, type Database, type Queryable } from "@/db";
import { withDeadline, INTERACTION_DB_DEADLINE_MS } from "@/lib/deadline";
import { log } from "@/lib/log";
import { enqueueJob } from "@/lib/jobs/queue";
import {
  InteractionSchema,
  InteractionType,
  ephemeralMessage,
  getInteractionUser,
  getStringOption,
  type Interaction,
  type InteractionResponseBody,
} from "@/lib/discord/types";
import { planReport } from "./report";
import { planStatus } from "./status";
import type { CommandPlan } from "./types";

/**
 * The single entry point the interactions route calls for every non-PING
 * interaction. Handles dedup-on-interaction-id, command dispatch, and the
 * "never silently lose an interaction" fallback -- all in one place so the
 * route handler itself stays a thin transport layer.
 */
export async function handleInteraction(db: Database, raw: unknown): Promise<InteractionResponseBody> {
  const parsed = InteractionSchema.safeParse(raw);
  if (!parsed.success) {
    log.warn("rejected interaction: payload failed schema validation", {
      issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
    return ephemeralMessage("Malformed request.");
  }
  const interaction = parsed.data;

  try {
    return await withDeadline("interaction-db-write", INTERACTION_DB_DEADLINE_MS, () =>
      db.transaction((tx) => processInteraction(tx, interaction)),
    );
  } catch (err) {
    // Note: withDeadline races the transaction against a timer but does not
    // (and cannot) cancel it -- if the DB write eventually completes after
    // we've already answered here, the interaction still gets recorded and
    // its jobs still run; the `reply` job (if any) will overwrite this
    // fallback text via PATCH @original once it does. So a slow DB costs the
    // user a confusing-but-honest "try again" message, not a lost report.
    log.error("failed to record interaction", {
      interactionId: interaction.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return ephemeralMessage("Couldn't record this — nothing was filed. Please try again.");
  }
}

async function processInteraction(tx: Queryable, interaction: Interaction): Promise<InteractionResponseBody> {
  const user = getInteractionUser(interaction);

  const inserted = await tx
    .insert(schema.interactions)
    .values({
      id: interaction.id,
      guildId: interaction.guild_id,
      channelId: interaction.channel_id,
      userId: user?.id,
      username: user?.username,
      type: interaction.type,
      command: interaction.data?.name,
      customId: interaction.data?.custom_id,
      inputText: getStringOption(interaction, "text"),
      status: "processing",
    })
    .onConflictDoNothing({ target: schema.interactions.id })
    .returning({ id: schema.interactions.id });

  if (inserted.length === 0) {
    return handleDuplicateDelivery(tx, interaction.id);
  }

  const plan = await computePlan(tx, interaction);

  await tx
    .update(schema.interactions)
    .set({ initialResponse: plan.response, status: "completed" })
    .where(eq(schema.interactions.id, interaction.id));

  for (const job of plan.jobs) {
    await enqueueJob(tx, { interactionId: interaction.id, ...job });
  }

  return plan.response;
}

/**
 * A second (or third, ...) delivery of an interaction id we've already
 * accepted. Because the row above only ever gets `initial_response` set
 * inside the same transaction that inserted it, by the time a concurrent
 * INSERT sees a conflict here, that transaction has committed -- Postgres
 * makes the second INSERT block until the first transaction finishes, so
 * there's no window where the row exists but the response doesn't.
 */
async function handleDuplicateDelivery(tx: Queryable, interactionId: string): Promise<InteractionResponseBody> {
  await tx
    .update(schema.interactions)
    .set({ duplicateCount: sql`${schema.interactions.duplicateCount} + 1` })
    .where(eq(schema.interactions.id, interactionId));

  const existing = await tx.query.interactions.findFirst({
    where: (i, { eq }) => eq(i.id, interactionId),
  });
  const stored = existing?.initialResponse as InteractionResponseBody | null | undefined;
  return stored ?? ephemeralMessage("Still working on your previous request — one moment.");
}

async function computePlan(tx: Queryable, interaction: Interaction): Promise<CommandPlan> {
  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    const name = interaction.data?.name;
    if (name === "report") return planReport(tx, interaction, interaction.id);
    if (name === "status") return planStatus(tx, interaction);
    return { response: ephemeralMessage(`Unknown command: /${name ?? "?"}`), jobs: [] };
  }
  if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
    // Buttons (Acknowledge/Resolve on a report) land in a later step.
    return { response: ephemeralMessage("This action isn't wired up yet."), jobs: [] };
  }
  if (interaction.type === InteractionType.MODAL_SUBMIT) {
    // The /report modal (for when no inline text is given) lands in a later step.
    return { response: ephemeralMessage("This form isn't wired up yet."), jobs: [] };
  }
  return { response: ephemeralMessage("Unsupported interaction type."), jobs: [] };
}
