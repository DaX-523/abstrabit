import { schema, type Queryable } from "@/db";

export const COMMANDS = ["report", "status"] as const;
export type CommandName = (typeof COMMANDS)[number];

export type CommandConfig = Pick<
  typeof schema.commandConfigs.$inferSelect,
  | "enabled"
  | "ephemeral"
  | "cooldownCount"
  | "cooldownWindowSeconds"
  | "modalWhenEmpty"
  | "postToChannel"
  | "mirror"
>;

/** Same as the column defaults: a server nobody has configured yet behaves this way. */
export const DEFAULT_COMMAND_CONFIG: CommandConfig = {
  enabled: true,
  ephemeral: true,
  cooldownCount: 0, // 0 = no rate limit
  cooldownWindowSeconds: 60,
  modalWhenEmpty: true,
  postToChannel: true,
  mirror: true,
};

/**
 * A server's settings for one command, falling back to the defaults when it
 * has no row -- which is the case for any server that ran a command before an
 * admin connected it on the dashboard.
 */
export async function getCommandConfig(
  db: Queryable,
  guildId: string,
  command: CommandName,
): Promise<CommandConfig> {
  const row = await db.query.commandConfigs.findFirst({
    where: (c, { and, eq }) => and(eq(c.guildId, guildId), eq(c.command, command)),
  });
  return row ?? DEFAULT_COMMAND_CONFIG;
}
