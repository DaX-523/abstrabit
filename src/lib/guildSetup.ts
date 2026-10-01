import { schema, type Queryable } from "@/db";
import { COMMANDS } from "@/lib/commandConfig";
import { STARTER_RULES } from "@/lib/rules";

/**
 * Called when an admin connects a server on the dashboard. Creates a default
 * settings row per command and, the first time only, the starter rules, so a
 * newly connected server shows a working "simple rule" straight away.
 *
 * Re-connecting an already-connected server changes nothing: existing
 * settings stay, and rules an admin deliberately deleted don't come back.
 */
export async function seedGuildDefaults(tx: Queryable, guildId: string): Promise<void> {
  const created = await tx
    .insert(schema.commandConfigs)
    .values(COMMANDS.map((command) => ({ guildId, command })))
    .onConflictDoNothing({ target: [schema.commandConfigs.guildId, schema.commandConfigs.command] })
    .returning({ command: schema.commandConfigs.command });

  if (created.length === 0) return;

  await tx.insert(schema.rules).values(
    STARTER_RULES.map((rule, position) => ({
      guildId,
      command: "report",
      position,
      condition: rule.condition,
      actions: rule.actions,
    })),
  );
}
