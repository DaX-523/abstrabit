import { describe, expect, it } from "vitest";
import { computeChannelPermissions, hasAllPermissions, PERMISSION, REQUIRED_CHANNEL_PERMISSIONS } from "@/lib/discord/permissions";

const BOT_ID = "bot-1";
const EVERYONE_ID = "guild-id"; // @everyone's role id == the guild id, per Discord

describe("computeChannelPermissions", () => {
  it("grants base role permissions with no overwrites", () => {
    const perms = computeChannelPermissions({
      everyoneRoleId: EVERYONE_ID,
      everyoneRolePermissions: PERMISSION.VIEW_CHANNEL,
      memberRolePermissions: [PERMISSION.SEND_MESSAGES],
      memberRoleIds: ["role-bot"],
      userId: BOT_ID,
      overwrites: [],
    });
    expect(hasAllPermissions(perms, [PERMISSION.VIEW_CHANNEL, PERMISSION.SEND_MESSAGES])).toBe(true);
  });

  it("an @everyone deny overwrite removes a base permission", () => {
    const perms = computeChannelPermissions({
      everyoneRoleId: EVERYONE_ID,
      everyoneRolePermissions: PERMISSION.VIEW_CHANNEL | PERMISSION.SEND_MESSAGES,
      memberRolePermissions: [],
      memberRoleIds: [],
      userId: BOT_ID,
      overwrites: [{ id: EVERYONE_ID, type: 0, allow: "0", deny: PERMISSION.SEND_MESSAGES.toString() }],
    });
    expect(hasAllPermissions(perms, [PERMISSION.VIEW_CHANNEL])).toBe(true);
    expect(hasAllPermissions(perms, [PERMISSION.SEND_MESSAGES])).toBe(false);
  });

  it("a role-specific allow overwrite re-grants what @everyone denied", () => {
    const perms = computeChannelPermissions({
      everyoneRoleId: EVERYONE_ID,
      everyoneRolePermissions: PERMISSION.VIEW_CHANNEL,
      memberRolePermissions: [0n],
      memberRoleIds: ["role-bot"],
      userId: BOT_ID,
      overwrites: [
        { id: EVERYONE_ID, type: 0, allow: "0", deny: PERMISSION.VIEW_CHANNEL.toString() },
        { id: "role-bot", type: 0, allow: PERMISSION.VIEW_CHANNEL.toString(), deny: "0" },
      ],
    });
    expect(hasAllPermissions(perms, [PERMISSION.VIEW_CHANNEL])).toBe(true);
  });

  it("a member-specific overwrite wins over a role overwrite", () => {
    const perms = computeChannelPermissions({
      everyoneRoleId: EVERYONE_ID,
      everyoneRolePermissions: PERMISSION.VIEW_CHANNEL,
      memberRolePermissions: [0n],
      memberRoleIds: ["role-bot"],
      userId: BOT_ID,
      overwrites: [
        { id: "role-bot", type: 0, allow: PERMISSION.SEND_MESSAGES.toString(), deny: "0" },
        { id: BOT_ID, type: 1, allow: "0", deny: PERMISSION.SEND_MESSAGES.toString() },
      ],
    });
    expect(hasAllPermissions(perms, [PERMISSION.SEND_MESSAGES])).toBe(false);
  });

  it("ADMINISTRATOR bypasses overwrites entirely", () => {
    const perms = computeChannelPermissions({
      everyoneRoleId: EVERYONE_ID,
      everyoneRolePermissions: 0n,
      memberRolePermissions: [PERMISSION.ADMINISTRATOR],
      memberRoleIds: ["role-admin"],
      userId: BOT_ID,
      overwrites: [{ id: EVERYONE_ID, type: 0, allow: "0", deny: PERMISSION.VIEW_CHANNEL.toString() }],
    });
    expect(hasAllPermissions(perms, REQUIRED_CHANNEL_PERMISSIONS)).toBe(true);
  });

  it("hasAllPermissions is false if any required bit is missing", () => {
    const perms = PERMISSION.VIEW_CHANNEL | PERMISSION.SEND_MESSAGES; // missing EMBED_LINKS
    expect(hasAllPermissions(perms, REQUIRED_CHANNEL_PERMISSIONS)).toBe(false);
  });
});
