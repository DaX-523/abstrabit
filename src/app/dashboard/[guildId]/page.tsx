import { redirect } from "next/navigation";

// The live command log lands here in a later step; for now, land admins on
// settings (the OAuth callback already sends first-time connects there).
export default async function GuildDashboardPage({ params }: { params: Promise<{ guildId: string }> }) {
  const { guildId } = await params;
  redirect(`/dashboard/${guildId}/settings`);
}
