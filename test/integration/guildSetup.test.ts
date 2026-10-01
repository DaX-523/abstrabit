import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/testDb";
import { schema } from "@/db";
import type { Database } from "@/db";
import { seedGuildDefaults } from "@/lib/guildSetup";
import { STARTER_RULES } from "@/lib/rules";

let db: Database;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(schema.guilds).values([
    { id: "g1", name: "One" },
    { id: "g2", name: "Two" },
  ]);
});
afterEach(async () => close());

const rulesOf = (guildId: string) => db.query.rules.findMany({ where: (r, { eq }) => eq(r.guildId, guildId) });
const configsOf = (guildId: string) => db.query.commandConfigs.findMany({ where: (c, { eq }) => eq(c.guildId, guildId) });

describe("seedGuildDefaults", () => {
  it("creates a settings row per command and the starter rules for a new server", async () => {
    await seedGuildDefaults(db, "g1");

    expect((await configsOf("g1")).map((c) => c.command).sort()).toEqual(["report", "status"]);
    const rules = await rulesOf("g1");
    expect(rules).toHaveLength(STARTER_RULES.length);
    expect(rules.every((r) => r.command === "report" && r.enabled)).toBe(true);
  });

  it("only seeds the server it's called for", async () => {
    await seedGuildDefaults(db, "g1");
    expect(await configsOf("g2")).toEqual([]);
    expect(await rulesOf("g2")).toEqual([]);
  });

  it("doesn't change anything when the server is connected again", async () => {
    await seedGuildDefaults(db, "g1");
    await db.update(schema.commandConfigs).set({ enabled: false }).where(eq(schema.commandConfigs.guildId, "g1"));
    await db.delete(schema.rules).where(eq(schema.rules.guildId, "g1")); // admin removed them on purpose

    await seedGuildDefaults(db, "g1");

    expect((await configsOf("g1")).every((c) => c.enabled === false)).toBe(true);
    expect(await rulesOf("g1")).toEqual([]);
  });
});
