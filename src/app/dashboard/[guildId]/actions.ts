"use server";

import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { requireGuildAdmin, AuthError } from "@/lib/auth";
import { encrypt } from "@/lib/crypto";
import { detectMirrorKind, sendMirror } from "@/lib/mirror";
import { postChannelMessage } from "@/lib/discord/api";
import { listPostableChannels } from "@/lib/discord/channels";
import { log } from "@/lib/log";

function settingsPath(guildId: string): string {
  return `/dashboard/${guildId}/settings`;
}

function redirectWithParam(guildId: string, key: "success" | "error", message: string): never {
  redirect(`${settingsPath(guildId)}?${key}=${encodeURIComponent(message)}`);
}

async function guardedGuildId(formData: FormData): Promise<string> {
  const guildId = String(formData.get("guildId") ?? "");
  if (!guildId) throw new AuthError("Missing guild id");
  const db = getDb();
  await requireGuildAdmin(db, guildId); // throws AuthError if not an admin of this guild
  return guildId;
}

export async function updateChannelAction(formData: FormData): Promise<void> {
  const guildId = await guardedGuildId(formData);
  const channelId = String(formData.get("channelId") ?? "");
  const db = getDb();

  if (channelId) {
    // Re-check server-side that the bot can actually post here -- never
    // trust that the client only submitted an option we rendered.
    const postable = await listPostableChannels(guildId);
    if (!postable.some((c) => c.id === channelId)) {
      redirectWithParam(guildId, "error", "That channel isn't one the bot can currently post in.");
    }
  }

  await db
    .update(schema.guilds)
    .set({ reportChannelId: channelId || null, updatedAt: new Date() })
    .where(eq(schema.guilds.id, guildId));

  redirectWithParam(guildId, "success", "Report channel updated.");
}

export async function updateMirrorAction(formData: FormData): Promise<void> {
  const guildId = await guardedGuildId(formData);
  const mirrorUrl = String(formData.get("mirrorUrl") ?? "").trim();
  const db = getDb();

  if (!mirrorUrl) {
    await db
      .update(schema.guilds)
      .set({ mirrorKind: "none", mirrorUrlEnc: null, updatedAt: new Date() })
      .where(eq(schema.guilds.id, guildId));
    redirectWithParam(guildId, "success", "Mirror disabled.");
  }

  const kind = detectMirrorKind(mirrorUrl);
  if (!kind) {
    redirectWithParam(guildId, "error", "That doesn't look like a Slack or Discord webhook URL.");
  }

  await db
    .update(schema.guilds)
    .set({ mirrorKind: kind, mirrorUrlEnc: encrypt(mirrorUrl), updatedAt: new Date() })
    .where(eq(schema.guilds.id, guildId));

  redirectWithParam(guildId, "success", `${kind === "slack" ? "Slack" : "Discord"} mirror saved.`);
}

export async function testChannelAction(formData: FormData): Promise<void> {
  const guildId = await guardedGuildId(formData);
  const db = getDb();
  const guild = await db.query.guilds.findFirst({ where: (g, { eq }) => eq(g.id, guildId) });

  if (!guild?.reportChannelId) {
    redirectWithParam(guildId, "error", "Set a report channel first.");
  }

  try {
    await postChannelMessage(guild.reportChannelId!, {
      content: "✅ Test message from the dashboard — this channel is wired up correctly.",
      allowed_mentions: { parse: [] },
    });
    redirectWithParam(guildId, "success", "Test message sent to the report channel.");
  } catch (err) {
    log.error("test channel post failed", { guildId, error: err instanceof Error ? err.message : String(err) });
    redirectWithParam(guildId, "error", "Couldn't post to that channel. Check the bot still has access.");
  }
}

export async function testMirrorAction(formData: FormData): Promise<void> {
  const guildId = await guardedGuildId(formData);
  const db = getDb();
  const guild = await db.query.guilds.findFirst({ where: (g, { eq }) => eq(g.id, guildId) });

  if (!guild?.mirrorUrlEnc) {
    redirectWithParam(guildId, "error", "Set a mirror URL first.");
  }

  try {
    const { decrypt } = await import("@/lib/crypto");
    await sendMirror(decrypt(guild.mirrorUrlEnc!), {
      title: "Test notification",
      lines: ["This is a test from the dashboard — your mirror is wired up correctly."],
    });
    redirectWithParam(guildId, "success", "Test message sent to the mirror.");
  } catch (err) {
    log.error("test mirror post failed", { guildId, error: err instanceof Error ? err.message : String(err) });
    redirectWithParam(guildId, "error", "Couldn't post to the mirror. Check the webhook is still valid.");
  }
}
