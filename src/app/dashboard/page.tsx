import { redirect } from "next/navigation";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { getCurrentUser } from "@/lib/auth";
import { logoutAction } from "@/app/actions/auth";

// Always personalized (session + DB backed) -- never attempt to statically
// prerender this at build time.
export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const db = getDb();
  const user = await getCurrentUser(db);
  if (!user) redirect("/login");

  const guilds = await db
    .select({ id: schema.guilds.id, name: schema.guilds.name })
    .from(schema.guildAdmins)
    .innerJoin(schema.guilds, eq(schema.guildAdmins.guildId, schema.guilds.id))
    .where(eq(schema.guildAdmins.userId, user.id));

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-4 py-10">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <form action={logoutAction}>
          <button type="submit" className="text-sm underline">
            Sign out ({user.email})
          </button>
        </form>
      </div>

      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      <a
        href="/api/discord/oauth/start"
        className="inline-block w-fit rounded-md bg-foreground px-3 py-2 text-sm font-medium text-background"
      >
        Connect a server
      </a>

      {guilds.length === 0 ? (
        <div className="rounded-md border border-black/10 p-6 text-sm text-black/70 dark:border-white/20 dark:text-white/70">
          No servers connected yet. Click &ldquo;Connect a server&rdquo; to invite the bot and pick a report channel.
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {guilds.map((g) => (
            <li key={g.id} className="rounded-md border border-black/10 p-4 dark:border-white/20">
              <Link href={`/dashboard/${g.id}/settings`} className="font-medium underline">
                {g.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
