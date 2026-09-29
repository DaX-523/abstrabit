import "server-only";
import { getEnv } from "@/lib/env";
import { RetryableError, PermanentError } from "@/lib/jobs/runner";

const DISCORD_API_BASE = "https://discord.com/api/v10";

/**
 * A thin wrapper over fetch for calls to Discord's bot REST API. Classifies
 * every failure so job handlers that call these functions get the right
 * retry behavior for free: network errors and 5xx are retried with backoff,
 * 429 is retried after Discord's own `retry_after`, and any other 4xx (bad
 * token, missing permission, unknown channel) is permanent -- retrying it
 * would just spin forever on something that can't self-heal.
 */
async function discordFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const env = getEnv();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bot ${env.DISCORD_BOT_TOKEN}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let res: Response;
  try {
    res = await fetch(`${DISCORD_API_BASE}${path}`, { ...init, headers });
  } catch (err) {
    throw new RetryableError(`network error calling Discord (${path}): ${String(err)}`);
  }

  if (res.status === 429) {
    let retryAfterMs = 1000;
    try {
      const body = (await res.clone().json()) as { retry_after?: number };
      if (typeof body.retry_after === "number") retryAfterMs = Math.ceil(body.retry_after * 1000);
    } catch {
      // fall through with the default
    }
    throw new RetryableError(`Discord rate limited (${path})`, { retryAfterMs, httpStatus: 429 });
  }

  if (res.status >= 500) {
    throw new RetryableError(`Discord ${res.status} on ${path}`, { httpStatus: res.status });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new PermanentError(`Discord ${res.status} on ${path}: ${text.slice(0, 300)}`, {
      httpStatus: res.status,
    });
  }

  return res;
}

/** Edits the interaction's original response. Works whether the original
 * response was deferred or immediate, as long as the interaction token
 * (15 min lifetime) hasn't expired. */
export async function patchOriginalResponse(
  applicationId: string,
  interactionToken: string,
  body: unknown,
): Promise<void> {
  await discordFetch(`/webhooks/${applicationId}/${interactionToken}/messages/@original`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

/** Sends a new followup message tied to the interaction token. */
export async function createFollowupMessage(
  applicationId: string,
  interactionToken: string,
  body: unknown,
): Promise<{ id: string }> {
  const res = await discordFetch(`/webhooks/${applicationId}/${interactionToken}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return res.json();
}

/** Posts a message to a channel using the bot's own token (not tied to any interaction). */
export async function postChannelMessage(channelId: string, body: unknown): Promise<{ id: string }> {
  const res = await discordFetch(`/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function editChannelMessage(
  channelId: string,
  messageId: string,
  body: unknown,
): Promise<void> {
  await discordFetch(`/channels/${channelId}/messages/${messageId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function getGuildChannels(guildId: string): Promise<
  Array<{ id: string; name: string; type: number; permission_overwrites?: unknown[] }>
> {
  const res = await discordFetch(`/guilds/${guildId}/channels`);
  return res.json();
}

export async function getCurrentBotUser(): Promise<{ id: string; username: string }> {
  const res = await discordFetch(`/users/@me`);
  return res.json();
}
