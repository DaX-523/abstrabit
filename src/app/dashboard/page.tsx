import { redirect } from "next/navigation";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { getCurrentUser } from "@/lib/auth";
import { logoutAction } from "@/app/actions/auth";
import { SubmitButton } from "@/components/SubmitButton";

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
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-4 py-10">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <form action={logoutAction}>
          <SubmitButton variant="secondary" pendingText="Signing out…">
            Sign out ({user.email})
          </SubmitButton>
        </form>
      </div>

      {error && (
        <p role="alert" className="alert-error">
          {error}
        </p>
      )}

      <a
        href="/api/discord/oauth/start"
        className="btn-primary w-fit"
      >
        Connect a server
      </a>

      {guilds.length === 0 ? (
        <div className="card text-sm text-muted">
          No servers connected yet. Click &ldquo;Connect a server&rdquo; to invite the bot and pick a report channel.
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {guilds.map((g) => (
            <li key={g.id}>
              <Link
                href={`/dashboard/${g.id}`}
                className="card flex items-center justify-between font-medium transition hover:border-accent"
              >
                {g.name}
                <span className="text-sm text-muted">Open →</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
