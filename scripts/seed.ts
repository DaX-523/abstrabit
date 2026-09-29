/**
 * Creates (or updates the password of) the throwaway admin account used for
 * grading/demo access, from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD. Safe to
 * re-run -- upserts rather than failing if the account already exists.
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

  if (existing) {
    await db.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, existing.id));
    console.log(`Updated password for existing admin: ${email}`);
  } else {
    await db.insert(schema.users).values({ email, passwordHash });
    console.log(`Created admin: ${email}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
