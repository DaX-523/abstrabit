import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestDb } from "../helpers/testDb";
import { schema } from "@/db";
import { sql } from "drizzle-orm";
import type { Database } from "@/db";

let db: Database;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});

afterAll(async () => {
  await close();
});

describe("schema migrations", () => {
  it("creates all expected tables", async () => {
    const result = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );
    // postgres-js returns an array-like RowList directly; PGlite returns
    // { rows }. Normalize so this test works against either driver.
    const rowArray = Array.isArray(result) ? result : (result as { rows: { table_name: string }[] }).rows;
    const names = rowArray.map((r) => r.table_name);
    for (const expected of [
      "users",
      "sessions",
      "guilds",
      "guild_admins",
      "command_configs",
      "rules",
      "interactions",
      "reports",
      "jobs",
      "job_attempts",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("dedups interactions on primary key via ON CONFLICT DO NOTHING", async () => {
    const row = {
      id: "interaction-dedup-1",
      type: 2,
      command: "report",
      status: "received" as const,
      inputText: "first",
    };
    await db.insert(schema.interactions).values(row);
    // Simulate a replayed delivery of the same interaction id with different
    // content -- it must be silently ignored, not overwrite or error.
    await db
      .insert(schema.interactions)
      .values({ ...row, inputText: "replayed-should-not-apply" })
      .onConflictDoNothing({ target: schema.interactions.id });

    const stored = await db.query.interactions.findFirst({
      where: (i, { eq }) => eq(i.id, "interaction-dedup-1"),
    });
    expect(stored?.inputText).toBe("first");
  });

  it("enforces one job per (interaction_id, kind)", async () => {
    await db.insert(schema.interactions).values({
      id: "interaction-for-job-1",
      type: 2,
      command: "report",
      status: "received",
    });
    await db.insert(schema.jobs).values({
      interactionId: "interaction-for-job-1",
      kind: "mirror",
      payloadEnc: "ciphertext-a",
    });
    await expect(
      db.insert(schema.jobs).values({
        interactionId: "interaction-for-job-1",
        kind: "mirror",
        payloadEnc: "ciphertext-b",
      }),
    ).rejects.toThrow();
  });

  it("cascades guild deletion to its command configs and rules", async () => {
    await db.insert(schema.guilds).values({ id: "guild-1", name: "Test Guild" });
    await db.insert(schema.commandConfigs).values({ guildId: "guild-1", command: "report" });
    await db.insert(schema.rules).values({
      guildId: "guild-1",
      command: "report",
      condition: { type: "always" },
      actions: [],
    });

    await db.delete(schema.guilds).where(sql`${schema.guilds.id} = 'guild-1'`);

    const configs = await db.query.commandConfigs.findMany({
      where: (c, { eq }) => eq(c.guildId, "guild-1"),
    });
    const guildRules = await db.query.rules.findMany({
      where: (r, { eq }) => eq(r.guildId, "guild-1"),
    });
    expect(configs).toHaveLength(0);
    expect(guildRules).toHaveLength(0);
  });
});
