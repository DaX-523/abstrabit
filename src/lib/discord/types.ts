import { z } from "zod";

/**
 * A deliberately partial model of Discord's interaction payload -- just the
 * fields this app actually reads. Validated with zod so a malformed or
 * unexpected payload becomes a typed rejection instead of a runtime crash
 * three layers deep in report/status handling.
 */
export const InteractionOptionSchema = z.object({
  name: z.string(),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

export const InteractionSchema = z.object({
  id: z.string(),
  application_id: z.string(),
  type: z.number(),
  token: z.string(),
  guild_id: z.string().optional(),
  channel_id: z.string().optional(),
  member: z
    .object({
      user: z.object({ id: z.string(), username: z.string() }).optional(),
      permissions: z.string().optional(),
    })
    .optional(),
  user: z.object({ id: z.string(), username: z.string() }).optional(),
  data: z
    .object({
      id: z.string().optional(),
      name: z.string().optional(),
      custom_id: z.string().optional(),
      options: z.array(InteractionOptionSchema).optional(),
      components: z.array(z.unknown()).optional(),
    })
    .optional(),
});

export type Interaction = z.infer<typeof InteractionSchema>;

export const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  APPLICATION_COMMAND_AUTOCOMPLETE: 4,
  MODAL_SUBMIT: 5,
} as const;

export const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  UPDATE_MESSAGE: 7,
  MODAL: 9,
} as const;

/** The MESSAGE_FLAGS.EPHEMERAL bit. */
export const EPHEMERAL_FLAG = 1 << 6;

export interface InteractionResponseBody {
  type: number;
  data?: {
    content?: string;
    flags?: number;
    embeds?: unknown[];
    components?: unknown[];
    allowed_mentions?: { parse: string[] };
    custom_id?: string;
    title?: string;
  };
}

export function getInteractionUser(interaction: Interaction): { id: string; username: string } | null {
  const fromMember = interaction.member?.user;
  const fromUser = interaction.user;
  const u = fromMember ?? fromUser;
  return u ? { id: u.id, username: u.username } : null;
}

export function getStringOption(interaction: Interaction, name: string): string | undefined {
  const opt = interaction.data?.options?.find((o) => o.name === name);
  return typeof opt?.value === "string" ? opt.value : undefined;
}

export function ephemeralMessage(content: string): InteractionResponseBody {
  return channelMessage(content, true);
}

/** An immediate reply; visible only to the caller when `ephemeral`. */
export function channelMessage(content: string, ephemeral: boolean): InteractionResponseBody {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content,
      ...(ephemeral ? { flags: EPHEMERAL_FLAG } : {}),
      allowed_mentions: { parse: [] },
    },
  };
}

/**
 * A text input's submitted value from a MODAL_SUBMIT payload. Handles both
 * layouts Discord uses: inputs wrapped in action rows (`components[].components[]`)
 * and in labels (`components[].component`).
 */
export function getModalValue(interaction: Interaction, customId: string): string | undefined {
  for (const row of interaction.data?.components ?? []) {
    const r = row as { components?: unknown; component?: unknown };
    const inputs = Array.isArray(r.components) ? r.components : r.component ? [r.component] : [];
    for (const input of inputs) {
      const i = input as { custom_id?: unknown; value?: unknown };
      if (i.custom_id === customId && typeof i.value === "string") return i.value;
    }
  }
  return undefined;
}
