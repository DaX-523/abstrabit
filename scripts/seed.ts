/**
 * Creates (or updates the password of) the throwaway admin account used for
 * grading/demo access, from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD. Safe to
 * re-run -- upserts rather than failing if the account already exists.
 *
 * Optional SEED_GUILD_ID: also make this account an admin of that
 * already-connected server, so a grader can log in and see its live log
 * without going through the Discord OAuth connect flow themselves.
 *
 * Usage: npm run seed
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { eq } from "drizzle-orm";
import { getDb, schema } from "../src/db";
import { hashPassword } from "../src/lib/auth";

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password) {
    console.error("SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must be set (check .env.local).");
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("SEED_ADMIN_PASSWORD must be at least 8 characters.");
    process.exit(1);
  }

  const db = getDb();
  const passwordHash = await hashPassword(password);

  const existing = await db.query.users.findFirst({
    where: (u, { sql }) => sql`lower(${u.email}) = lower(${email})`,
  });

  let userId: string;
  if (existing) {
    await db.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, existing.id));
    userId = existing.id;
    console.log(`Updated password for existing admin: ${email}`);
  } else {
    const [created] = await db.insert(schema.users).values({ email, passwordHash }).returning();
    userId = created.id;
    console.log(`Created admin: ${email}`);
  }

  const guildId = process.env.SEED_GUILD_ID;
  if (guildId) {
    const guild = await db.query.guilds.findFirst({ where: (g, { eq }) => eq(g.id, guildId) });
    if (!guild) {
      console.error(`No server with id ${guildId} -- connect it from the dashboard first.`);
      process.exit(1);
    }
    await db.insert(schema.guildAdmins).values({ guildId, userId }).onConflictDoNothing();
    console.log(`Linked ${email} as an admin of "${guild.name}".`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
