import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { getDb } from "@/db";
import { requireGuildAdmin, AuthError } from "@/lib/auth";
import { getRecentInteractions } from "@/lib/feed";
import { LiveLog } from "@/components/LiveLog";

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
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{guild.name}</h1>
        <Link href="/dashboard" className="link text-sm">
          ← All servers
        </Link>
      </div>

      <nav className="flex gap-1 border-b border-border text-sm">
        <Link href={`/dashboard/${guildId}`} aria-current="page" className="-mb-px border-b-2 border-accent px-3 py-2 font-medium">
          Live log
        </Link>
        <Link href={`/dashboard/${guildId}/settings`} className="-mb-px border-b-2 border-transparent px-3 py-2 text-muted hover:text-foreground">
          Settings
        </Link>
      </nav>

      <LiveLog guildId={guildId} initialItems={initialItems} />
    </main>
  );
}
