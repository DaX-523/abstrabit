import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestDb } from "../helpers/testDb";
import { schema } from "@/db";
import type { Database } from "@/db";
import { getRecentInteractions } from "@/lib/feed";
import { enqueueJob } from "@/lib/jobs/queue";

let db: Database;
let close: () => Promise<void>;

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  ({ db, close } = await createTestDb());
  await db.insert(schema.guilds).values({ id: "feed-guild", name: "Feed Guild" });
});

afterAll(() => close());

async function makeInteraction(id: string, offsetMs: number) {
  await db.insert(schema.interactions).values({
    id,
    guildId: "feed-guild",
    type: 2,
    command: "report",
    status: "completed",
    createdAt: new Date(Date.now() + offsetMs),
  });
}

describe("getRecentInteractions", () => {
  it("returns interactions for the guild, oldest first, with their jobs attached", async () => {
    await makeInteraction("feed-1", 0);
    await makeInteraction("feed-2", 10);
    await enqueueJob(db, { interactionId: "feed-1", kind: "reply", payload: {} });
    await enqueueJob(db, { interactionId: "feed-1", kind: "mirror", payload: {} });

    const items = await getRecentInteractions(db, "feed-guild");
    const first = items.find((i) => i.id === "feed-1");
    expect(first?.jobs.map((j) => j.kind).sort()).toEqual(["mirror", "reply"]);

    const ids = items.map((i) => i.id);
    expect(ids.indexOf("feed-1")).toBeLessThan(ids.indexOf("feed-2"));
  });

  it("does not return another guild's interactions", async () => {
    await db.insert(schema.guilds).values({ id: "other-guild", name: "Other" });
    await db.insert(schema.interactions).values({
      id: "other-guild-interaction",
      guildId: "other-guild",
      type: 2,
      command: "status",
      status: "completed",
    });
    const items = await getRecentInteractions(db, "feed-guild");
    expect(items.some((i) => i.id === "other-guild-interaction")).toBe(false);
  });

  it("with `after`, returns only interactions created after that time, ascending", async () => {
    const all = await getRecentInteractions(db, "feed-guild");
    const cutoff = new Date(all[0].createdAt);
    const items = await getRecentInteractions(db, "feed-guild", { after: cutoff });
    expect(items.every((i) => new Date(i.createdAt).getTime() > cutoff.getTime())).toBe(true);
  });
});
