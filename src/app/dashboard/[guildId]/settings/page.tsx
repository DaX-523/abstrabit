import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { getDb } from "@/db";
import { requireGuildAdmin, AuthError } from "@/lib/auth";
import { maskUrl, decrypt } from "@/lib/crypto";
import { listPostableChannels } from "@/lib/discord/channels";
import { log } from "@/lib/log";
import { updateChannelAction, updateMirrorAction, testChannelAction, testMirrorAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ guildId: string }>;
  searchParams: Promise<{ success?: string; error?: string }>;
}) {
  const { guildId } = await params;
  const { success, error } = await searchParams;
  const db = getDb();

  try {
    await requireGuildAdmin(db, guildId);
  } catch (err) {
    if (err instanceof AuthError) redirect("/login");
    throw err;
  }

  const guild = await db.query.guilds.findFirst({ where: (g, { eq }) => eq(g.id, guildId) });
  if (!guild) notFound();

  let postableChannels: Array<{ id: string; name: string }> = [];
  let channelsError: string | null = null;
  try {
    postableChannels = await listPostableChannels(guildId);
  } catch (err) {
    log.error("failed to list postable channels", { guildId, error: err instanceof Error ? err.message : String(err) });
    channelsError = "Couldn't load this server's channels from Discord right now.";
  }

  const mirrorUrlPreview = guild.mirrorUrlEnc ? maskUrl(decrypt(guild.mirrorUrlEnc)) : null;

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-8 px-4 py-10">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{guild.name}</h1>
        <Link href="/dashboard" className="text-sm underline">
          ← All servers
        </Link>
      </div>

      {success && (
        <p role="status" className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950 dark:text-green-300">
          {success}
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      <nav className="flex gap-4 text-sm">
        <Link href={`/dashboard/${guildId}`} className="underline">
          Live log
        </Link>
        <Link href={`/dashboard/${guildId}/settings`} className="font-medium">
          Settings
        </Link>
      </nav>

      <section className="flex flex-col gap-3">
        <h2 className="font-medium">Report channel</h2>
        <p className="text-sm text-black/60 dark:text-white/60">
          Where the bot posts each /report submission.
        </p>
        {channelsError ? (
          <p className="text-sm text-red-600">{channelsError}</p>
        ) : (
          <form action={updateChannelAction} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="guildId" value={guildId} />
            <select
              name="channelId"
              defaultValue={guild.reportChannelId ?? ""}
              className="rounded-md border border-black/10 px-3 py-2 text-sm dark:border-white/20"
            >
              <option value="">— none —</option>
              {postableChannels.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.name}
                </option>
              ))}
            </select>
            <button type="submit" className="rounded-md bg-foreground px-3 py-1.5 text-sm text-background">
              Save
            </button>
          </form>
        )}
        {guild.reportChannelId && (
          <form action={testChannelAction}>
            <input type="hidden" name="guildId" value={guildId} />
            <button type="submit" className="text-sm underline">
              Send test message
            </button>
          </form>
        )}
        {postableChannels.length === 0 && !channelsError && (
          <p className="text-sm text-amber-600">
            No channels found where the bot can post. Give it View Channel + Send Messages + Embed
            Links on a channel, then reload this page.
          </p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-medium">Mirror (second channel)</h2>
        <p className="text-sm text-black/60 dark:text-white/60">
          A Slack Incoming Webhook or a separate Discord channel webhook. Stored encrypted; only a
          masked preview is ever shown here.
        </p>
        {mirrorUrlPreview && (
          <p className="text-sm font-mono">{mirrorUrlPreview}</p>
        )}
        <form action={updateMirrorAction} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="guildId" value={guildId} />
          <input
            type="url"
            name="mirrorUrl"
            placeholder="https://hooks.slack.com/services/..."
            className="min-w-64 flex-1 rounded-md border border-black/10 px-3 py-2 text-sm dark:border-white/20"
          />
          <button type="submit" className="rounded-md bg-foreground px-3 py-1.5 text-sm text-background">
            Save
          </button>
        </form>
        {guild.mirrorUrlEnc && (
          <form action={testMirrorAction}>
            <input type="hidden" name="guildId" value={guildId} />
            <button type="submit" className="text-sm underline">
              Send test message
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
