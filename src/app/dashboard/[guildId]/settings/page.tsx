import { redirect, notFound } from "next/navigation";
import { getDb } from "@/db";
import { requireGuildAdmin, AuthError } from "@/lib/auth";
import { maskUrl, decrypt } from "@/lib/crypto";
import { listPostableChannels } from "@/lib/discord/channels";
import { log } from "@/lib/log";
import { SubmitButton } from "@/components/SubmitButton";
import { GuildHeader } from "@/components/GuildHeader";
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
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-4 py-10">
      <GuildHeader guildId={guildId} name={guild.name} active="settings" />

      {success && (
        <p role="status" className="alert-success">
          {success}
        </p>
      )}
      {error && (
        <p role="alert" className="alert-error">
          {error}
        </p>
      )}

      <section className="card flex flex-col gap-3">
        <h2 className="font-semibold">Report channel</h2>
        <p className="text-sm text-muted">
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
              className="input w-auto"
            >
              <option value="">— none —</option>
              {postableChannels.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.name}
                </option>
              ))}
            </select>
            <SubmitButton pendingText="Saving…">Save</SubmitButton>
          </form>
        )}
        {guild.reportChannelId && (
          <form action={testChannelAction}>
            <input type="hidden" name="guildId" value={guildId} />
            <SubmitButton variant="secondary" pendingText="Sending…">
              Send test message
            </SubmitButton>
          </form>
        )}
        {postableChannels.length === 0 && !channelsError && (
          <p className="text-sm text-amber-600">
            No channels found where the bot can post. Give it View Channel + Send Messages + Embed
            Links on a channel, then reload this page.
          </p>
        )}
      </section>

      <section className="card flex flex-col gap-3">
        <h2 className="font-semibold">Mirror (second channel)</h2>
        <p className="text-sm text-muted">
          A Slack Incoming Webhook or a separate Discord channel webhook. Stored encrypted; only a
          masked preview is ever shown here.
        </p>
        {mirrorUrlPreview && (
          <p className="rounded-md bg-foreground/5 px-3 py-2 font-mono text-sm">{mirrorUrlPreview}</p>
        )}
        <form action={updateMirrorAction} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="guildId" value={guildId} />
          <input
            type="url"
            name="mirrorUrl"
            placeholder="https://hooks.slack.com/services/..."
            className="input min-w-64 flex-1"
          />
          <SubmitButton pendingText="Saving…">Save</SubmitButton>
        </form>
        {guild.mirrorUrlEnc && (
          <form action={testMirrorAction}>
            <input type="hidden" name="guildId" value={guildId} />
            <SubmitButton variant="secondary" pendingText="Sending…">
              Send test message
            </SubmitButton>
          </form>
        )}
      </section>
    </main>
  );
}
