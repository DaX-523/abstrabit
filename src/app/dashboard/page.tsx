import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/auth";
import { logoutAction } from "@/app/actions/auth";

// Always personalized (session + DB backed) -- never attempt to statically
// prerender this at build time.
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const db = getDb();
  const user = await getCurrentUser(db);
  if (!user) redirect("/login");

  const guilds = await db.query.guildAdmins.findMany({
    where: (a, { eq }) => eq(a.userId, user.id),
  });

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

      {guilds.length === 0 ? (
        <div className="rounded-md border border-black/10 p-6 text-sm text-black/70 dark:border-white/20 dark:text-white/70">
          <p>No servers connected yet.</p>
          <p className="mt-2">
            Connecting a server (inviting the bot and picking a channel) is coming in the next step.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {guilds.map((a) => (
            <li key={a.guildId} className="rounded-md border border-black/10 p-4 dark:border-white/20">
              {a.guildId}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
