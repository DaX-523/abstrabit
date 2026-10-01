import { redirect, notFound } from "next/navigation";
import { getDb } from "@/db";
import { requireGuildAdmin, AuthError } from "@/lib/auth";
import { getRecentInteractions } from "@/lib/feed";
import { LiveLog } from "@/components/LiveLog";
import { GuildHeader } from "@/components/GuildHeader";

export const dynamic = "force-dynamic";

export default async function GuildDashboardPage({ params }: { params: Promise<{ guildId: string }> }) {
  const { guildId } = await params;
  const db = getDb();

  try {
    await requireGuildAdmin(db, guildId);
  } catch (err) {
    if (err instanceof AuthError) redirect("/login");
    throw err;
  }

  const guild = await db.query.guilds.findFirst({ where: (g, { eq }) => eq(g.id, guildId) });
  if (!guild) notFound();

  const initialItems = await getRecentInteractions(db, guildId);

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-4 py-10">
      <GuildHeader guildId={guildId} name={guild.name} active="log" />

      <LiveLog guildId={guildId} initialItems={initialItems} />
    </main>
  );
}
