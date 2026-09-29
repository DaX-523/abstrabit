/**
 * Discord's documented permission-resolution algorithm, implemented as a
 * pure function so the channel picker's "can the bot actually post here?"
 * filter is unit-testable without hitting the API. Order matters:
 * base (roles) -> @everyone overwrite -> role overwrites (combined) ->
 * member-specific overwrite. ADMINISTRATOR short-circuits all of it.
 * https://discord.com/developers/docs/topics/permissions#permission-overwrites
 */

export const PERMISSION = {
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  MANAGE_MESSAGES: 1n << 13n,
  EMBED_LINKS: 1n << 14n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  ADMINISTRATOR: 1n << 3n,
} as const;

/** A bitmask with every bit Discord currently defines set (permission flags
 * top out around bit 47 as of this writing); used as "everything" for an
 * Administrator, rather than only whatever bits their roles happen to OR to. */
const ALL_PERMISSIONS = (1n << 50n) - 1n;

/** What a bot needs in a channel to post the report embed with buttons. */
export const REQUIRED_CHANNEL_PERMISSIONS = [
  PERMISSION.VIEW_CHANNEL,
  PERMISSION.SEND_MESSAGES,
  PERMISSION.EMBED_LINKS,
] as const;

export interface Overwrite {
  id: string;
  /** 0 = role, 1 = member */
  type: 0 | 1;
  allow: string;
  deny: string;
}

export interface ComputePermissionsParams {
  everyoneRoleId: string;
  everyoneRolePermissions: bigint;
  /** Permissions of every non-@everyone role the member holds. */
  memberRolePermissions: bigint[];
  memberRoleIds: string[];
  userId: string;
  overwrites: Overwrite[];
}

export function computeChannelPermissions(params: ComputePermissionsParams): bigint {
  let permissions = params.everyoneRolePermissions;
  for (const rolePerm of params.memberRolePermissions) permissions |= rolePerm;

  if ((permissions & PERMISSION.ADMINISTRATOR) === PERMISSION.ADMINISTRATOR) {
    // Administrator implicitly has every permission, not just whatever bits
    // its roles happen to OR together, and overwrites don't apply to it.
    return ALL_PERMISSIONS;
  }

  const everyoneOverwrite = params.overwrites.find((o) => o.id === params.everyoneRoleId);
  if (everyoneOverwrite) {
    permissions &= ~BigInt(everyoneOverwrite.deny);
    permissions |= BigInt(everyoneOverwrite.allow);
  }

  let roleAllow = 0n;
  let roleDeny = 0n;
  for (const overwrite of params.overwrites) {
    if (overwrite.type === 0 && params.memberRoleIds.includes(overwrite.id)) {
      roleAllow |= BigInt(overwrite.allow);
      roleDeny |= BigInt(overwrite.deny);
    }
  }
  permissions &= ~roleDeny;
  permissions |= roleAllow;

  const memberOverwrite = params.overwrites.find((o) => o.type === 1 && o.id === params.userId);
  if (memberOverwrite) {
    permissions &= ~BigInt(memberOverwrite.deny);
    permissions |= BigInt(memberOverwrite.allow);
  }

  return permissions;
}

export function hasAllPermissions(permissions: bigint, required: readonly bigint[]): boolean {
  return required.every((p) => (permissions & p) === p);
}
