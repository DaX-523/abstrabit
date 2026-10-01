import Link from "next/link";

const TABS = [
  { key: "log", label: "Live log", path: "" },
  { key: "commands", label: "Commands", path: "/commands" },
  { key: "failures", label: "Failures", path: "/failures" },
  { key: "settings", label: "Settings", path: "/settings" },
] as const;

export type GuildTab = (typeof TABS)[number]["key"];

/** Title row + tab bar shared by every page under /dashboard/[guildId]. */
export function GuildHeader({ guildId, name, active }: { guildId: string; name: string; active: GuildTab }) {
  return (
    <>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{name}</h1>
        <Link href="/dashboard" className="link text-sm">
          ← All servers
        </Link>
      </div>

      <nav className="flex gap-1 border-b border-border text-sm">
        {TABS.map((tab) => (
          <Link
            key={tab.key}
            href={`/dashboard/${guildId}${tab.path}`}
            aria-current={tab.key === active ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 ${
              tab.key === active
                ? "border-accent font-medium"
                : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
    </>
  );
}
