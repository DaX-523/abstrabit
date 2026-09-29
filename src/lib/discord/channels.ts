import "server-only";
import { getEnv } from "@/lib/env";
import { getGuildChannels, getGuildRoles, getGuildMember } from "./api";
import { computeChannelPermissions, hasAllPermissions, REQUIRED_CHANNEL_PERMISSIONS } from "./permissions";

const GUILD_TEXT_CHANNEL_TYPE = 0;

/**
 * The channels in a guild the bot can actually post an embed to: text
 * channels where its resolved permissions include view + send + embed
 * links. Used to populate the settings page's channel picker so an admin
 * can't pick a channel the bot will silently fail to post in later.
 */
export async function listPostableChannels(guildId: string): Promise<Array<{ id: string; name: string }>> {
  const botUserId = getEnv().DISCORD_APPLICATION_ID; // a bot's user id equals its application id

  const [channels, roles, member] = await Promise.all([
    getGuildChannels(guildId),
    getGuildRoles(guildId),
    getGuildMember(guildId, botUserId),
  ]);

  const everyoneRole = roles.find((r) => r.id === guildId);
  const everyoneRolePermissions = BigInt(everyoneRole?.permissions ?? "0");
  const memberRoleIds = member?.roles ?? [];
  const memberRolePermissions = roles.filter((r) => memberRoleIds.includes(r.id)).map((r) => BigInt(r.permissions));

  return channels
    .filter((c) => c.type === GUILD_TEXT_CHANNEL_TYPE)
    .filter((c) => {
      const permissions = computeChannelPermissions({
        everyoneRoleId: guildId,
        everyoneRolePermissions,
        memberRolePermissions,
        memberRoleIds,
        userId: botUserId,
        overwrites: ((c.permission_overwrites ?? []) as Array<{ id: string; type: 0 | 1; allow: string; deny: string }>),
      });
      return hasAllPermissions(permissions, REQUIRED_CHANNEL_PERMISSIONS);
    })
    .map((c) => ({ id: c.id, name: c.name }));
}
