"use server";

import { and, asc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { COMMANDS, type CommandName } from "@/lib/commandConfig";
import {
  ActionsSchema,
  ConditionSchema,
  MAX_RULES_PER_COMMAND,
  PRIORITIES,
  STARTER_RULES,
  type Action,
  type Priority,
} from "@/lib/rules";
import { guardedGuildId, redirectWithMessage } from "../guard";

// Rules only exist for /report today (/status has nothing a rule could change).
const RULE_COMMAND = "report";

function back(guildId: string, key: "success" | "error", message: string): never {
  redirectWithMessage(`/dashboard/${guildId}/commands`, key, message);
}

function checkbox(formData: FormData, name: string): boolean {
  return formData.get(name) === "on";
}

function wholeNumber(formData: FormData, name: string, min: number, max: number): number | null {
  const raw = String(formData.get(name) ?? "").trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

function isCommand(value: string): value is CommandName {
  return (COMMANDS as readonly string[]).includes(value);
}

export async function updateCommandConfigAction(formData: FormData): Promise<void> {
  const guildId = await guardedGuildId(formData);
  const command = String(formData.get("command") ?? "");
  if (!isCommand(command)) back(guildId, "error", "Unknown command.");

  const patch: Partial<typeof schema.commandConfigs.$inferInsert> = {
    enabled: checkbox(formData, "enabled"),
    ephemeral: checkbox(formData, "ephemeral"),
  };

  if (command === "report") {
    const cooldownCount = wholeNumber(formData, "cooldownCount", 0, 100);
    const cooldownWindowSeconds = wholeNumber(formData, "cooldownWindowSeconds", 10, 3600);
    if (cooldownCount === null) back(guildId, "error", "Rate limit must be a whole number from 0 to 100.");
    if (cooldownWindowSeconds === null) back(guildId, "error", "Rate-limit window must be 10–3600 seconds.");
    patch.modalWhenEmpty = checkbox(formData, "modalWhenEmpty");
    patch.postToChannel = checkbox(formData, "postToChannel");
    patch.mirror = checkbox(formData, "mirror");
    patch.cooldownCount = cooldownCount;
    patch.cooldownWindowSeconds = cooldownWindowSeconds;
  }

  patch.updatedAt = new Date();
  await getDb()
    .insert(schema.commandConfigs)
    .values({ guildId, command, ...patch })
    .onConflictDoUpdate({ target: [schema.commandConfigs.guildId, schema.commandConfigs.command], set: patch });

  back(guildId, "success", `/${command} settings saved.`);
}

export async function addRuleAction(formData: FormData): Promise<void> {
  const guildId = await guardedGuildId(formData);
  const db = getDb();

  const keywords = String(formData.get("keywords") ?? "").trim();
  const condition = ConditionSchema.safeParse(
    keywords ? { type: "text_contains", value: keywords } : { type: "always" },
  );
  if (!condition.success) back(guildId, "error", "Keywords must be 1–100 characters.");

  const actionType = String(formData.get("actionType") ?? "");
  let action: Action | null = null;
  if (actionType === "set_priority") {
    const value = String(formData.get("priority") ?? "");
    if ((PRIORITIES as readonly string[]).includes(value)) action = { type: "set_priority", value: value as Priority };
  } else if (actionType === "skip_mirror") {
    action = { type: "skip_mirror" };
  } else if (actionType === "reply_note") {
    action = { type: "reply_note", text: String(formData.get("note") ?? "") };
  }
  const actions = ActionsSchema.safeParse(action ? [action] : []);
  if (!actions.success) back(guildId, "error", "Pick an action (a note must be 1–200 characters).");

  const existing = await db
    .select({ count: sql<number>`count(*)::int`, maxPosition: sql<number>`coalesce(max(${schema.rules.position}), -1)::int` })
    .from(schema.rules)
    .where(and(eq(schema.rules.guildId, guildId), eq(schema.rules.command, RULE_COMMAND)));
  if (existing[0].count >= MAX_RULES_PER_COMMAND) {
    back(guildId, "error", `You can have at most ${MAX_RULES_PER_COMMAND} rules.`);
  }

  await db.insert(schema.rules).values({
    guildId,
    command: RULE_COMMAND,
    position: existing[0].maxPosition + 1,
    condition: condition.data,
    actions: actions.data,
  });

  back(guildId, "success", "Rule added.");
}

export async function addStarterRulesAction(formData: FormData): Promise<void> {
  const guildId = await guardedGuildId(formData);
  const db = getDb();

  const existing = await db.query.rules.findFirst({
    where: (r, { and, eq }) => and(eq(r.guildId, guildId), eq(r.command, RULE_COMMAND)),
  });
  if (existing) back(guildId, "error", "This server already has rules.");

  await db.insert(schema.rules).values(
    STARTER_RULES.map((rule, position) => ({
      guildId,
      command: RULE_COMMAND,
      position,
      condition: rule.condition,
      actions: rule.actions,
    })),
  );
  back(guildId, "success", "Starter rules added.");
}

export async function toggleRuleAction(formData: FormData): Promise<void> {
  const guildId = await guardedGuildId(formData);
  const ruleId = String(formData.get("ruleId") ?? "");

  // Scoped by guild_id so an admin can only touch their own server's rules.
  const updated = await getDb()
    .update(schema.rules)
    .set({ enabled: sql`not ${schema.rules.enabled}` })
    .where(and(eq(schema.rules.id, ruleId), eq(schema.rules.guildId, guildId)))
    .returning({ id: schema.rules.id });
  if (updated.length === 0) back(guildId, "error", "Rule not found.");

  back(guildId, "success", "Rule updated.");
}

export async function deleteRuleAction(formData: FormData): Promise<void> {
  const guildId = await guardedGuildId(formData);
  const ruleId = String(formData.get("ruleId") ?? "");

  const deleted = await getDb()
    .delete(schema.rules)
    .where(and(eq(schema.rules.id, ruleId), eq(schema.rules.guildId, guildId)))
    .returning({ id: schema.rules.id });
  if (deleted.length === 0) back(guildId, "error", "Rule not found.");

  back(guildId, "success", "Rule deleted.");
}

export async function moveRuleAction(formData: FormData): Promise<void> {
  const guildId = await guardedGuildId(formData);
  const ruleId = String(formData.get("ruleId") ?? "");
  const direction = formData.get("direction") === "up" ? -1 : 1;
  const db = getDb();

  const moved = await db.transaction(async (tx) => {
    const ordered = await tx
      .select({ id: schema.rules.id })
      .from(schema.rules)
      .where(and(eq(schema.rules.guildId, guildId), eq(schema.rules.command, RULE_COMMAND)))
      .orderBy(asc(schema.rules.position), asc(schema.rules.id));

    const from = ordered.findIndex((r) => r.id === ruleId);
    const to = from + direction;
    if (from === -1 || to < 0 || to >= ordered.length) return false;

    [ordered[from], ordered[to]] = [ordered[to], ordered[from]];
    // Rewrite every position, so duplicates or gaps from earlier edits can't make the swap a no-op.
    for (const [position, rule] of ordered.entries()) {
      await tx
        .update(schema.rules)
        .set({ position })
        .where(and(eq(schema.rules.id, rule.id), eq(schema.rules.guildId, guildId)));
    }
    return true;
  });

  if (!moved) back(guildId, "error", "Couldn't move that rule.");
  back(guildId, "success", "Rule order updated.");
}
