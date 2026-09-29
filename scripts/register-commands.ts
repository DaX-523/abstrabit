/**
 * Registers the app's global slash commands with Discord via a bulk
 * overwrite PUT, which is idempotent -- safe to re-run any time a command's
 * definition changes, and it won't create duplicates.
 *
 * Usage: npm run discord:register
 * Requires DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN in the environment
 * (.env.local is loaded automatically).
 */
import { config } from "dotenv";
config({ path: ".env.local" });

const applicationId = process.env.DISCORD_APPLICATION_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;

if (!applicationId || !botToken) {
  console.error("DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN must be set (check .env.local).");
  process.exit(1);
}

const commands = [
  {
    name: "report",
    description: "File a report",
    type: 1, // CHAT_INPUT
    // Guild-only: reports/status are tied to a connected server's config.
    contexts: [0],
    options: [
      {
        name: "text",
        description: "What's going on",
        type: 3, // STRING
        required: false,
      },
    ],
  },
  {
    name: "status",
    description: "Show this server's connection, open reports, and your recent reports",
    type: 1,
    contexts: [0],
  },
];

async function main() {
  const res = await fetch(`https://discord.com/api/v10/applications/${applicationId}/commands`, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`Failed to register commands: ${res.status} ${text}`);
    process.exit(1);
  }

  const registered = (await res.json()) as Array<{ name: string; id: string }>;
  console.log(`Registered ${registered.length} global command(s):`);
  for (const cmd of registered) {
    console.log(`  /${cmd.name} (id: ${cmd.id})`);
  }
  console.log(
    "\nGlobal commands can take up to an hour to propagate on first registration; " +
      "updates to existing commands are usually near-instant.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
