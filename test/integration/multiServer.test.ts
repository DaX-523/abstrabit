import { eq } from "drizzle-orm";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestDb } from "../helpers/testDb";
import { schema } from "@/db";
import type { Database } from "@/db";
import { decrypt, encrypt } from "@/lib/crypto";
import { getRecentInteractions } from "@/lib/feed";
import { handleInteraction } from "@/lib/interactions/handle";

/**
 * Two servers sharing one deployment must behave as if they were separate
 * installations: each has its own channel, mirror, command settings and
 * rules, and nothing one server does leaks into the other.
 */

let db: Database;
let close: () => Promise<void>;

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 8).toString("base64");
  ({ db, close } = await createTestDb());

  await db.insert(schema.guilds).values([
    {
      id: "guild-a",
      name: "Alpha",
      reportChannelId: "alpha-reports",
      mirrorKind: "slack",
      mirrorUrlEnc: encrypt("https://hooks.slack.com/services/T0/B0/alpha"),
    },
    {
      id: "guild-b",
      name: "Beta",
      reportChannelId: "beta-reports",
      mirrorKind: "discord",
      mirrorUrlEnc: encrypt("https://discord.com/api/webhooks/1/beta"),
    },
  ]);
});

afterAll(async () => {
  await close();
});

let counter = 0;
function report(guildId: string, text: string, userId = "user-1") {
  const id = `ms-interaction-${++counter}`;
  return {
    id,
    application_id: "app-1",
    type: 2,
    token: `token-${id}`,
    guild_id: guildId,
    member: { user: { id: userId, username: userId } },
    data: { name: "report", options: [{ name: "text", value: text }] },
  };
}

const reportOf = (interactionId: string) =>
  db.query.reports.findFirst({ where: (r, { eq }) => eq(r.interactionId, interactionId) });

async function jobPayloads(interactionId: string) {
  const jobs = await db.query.jobs.findMany({ where: (j, { eq }) => eq(j.interactionId, interactionId) });
  return Object.fromEntries(jobs.map((j) => [j.kind, JSON.parse(decrypt(j.payloadEnc))]));
}

describe("rules and settings are per server", () => {
  beforeAll(async () => {
    // Alpha escalates "outage" and mirrors nothing marked internal; Beta has no rules at all.
    await db.insert(schema.rules).values({
      guildId: "guild-a",
      command: "report",
      condition: { type: "text_contains", value: "outage" },
      actions: [{ type: "set_priority", value: "critical" }],
    });
  });

  it("a rule on one server doesn't apply to the same text on another", async () => {
    const a = report("guild-a", "total outage");
    const b = report("guild-b", "total outage");
    await handleInteraction(db, a);
    await handleInteraction(db, b);

    expect((await reportOf(a.id))?.priority).toBe("critical");
    expect((await reportOf(b.id))?.priority).toBe("medium");
  });

  it("disabling /report on one server leaves the other working", async () => {
    await db.insert(schema.commandConfigs).values({ guildId: "guild-b", command: "report", enabled: false });

    const a = report("guild-a", "hello");
    const b = report("guild-b", "hello");
    expect((await handleInteraction(db, a)).type).toBe(5);
    expect((await handleInteraction(db, b)).data?.content).toMatch(/turned off/i);
    expect(await reportOf(a.id)).toBeDefined();
    expect(await reportOf(b.id)).toBeUndefined();

    await db.delete(schema.commandConfigs); // reset for the tests below
  });

  it("each report's jobs target that server's own channel and mirror", async () => {
    const a = report("guild-a", "route me");
    const b = report("guild-b", "route me");
    await handleInteraction(db, a);
    await handleInteraction(db, b);

    const pa = await jobPayloads(a.id);
    const pb = await jobPayloads(b.id);
    expect(pa.channel_post).toMatchObject({ guildId: "guild-a", channelId: "alpha-reports" });
    expect(pb.channel_post).toMatchObject({ guildId: "guild-b", channelId: "beta-reports" });
    expect(pa.mirror.guildId).toBe("guild-a");
    expect(pb.mirror.guildId).toBe("guild-b");
  });

  it("a rate limit counts reports per server, not across them", async () => {
    await db.insert(schema.commandConfigs).values({
      guildId: "guild-a",
      command: "report",
      cooldownCount: 1,
      cooldownWindowSeconds: 3600,
    });

    // The same person (same Discord user id) files in both servers.
    expect((await handleInteraction(db, report("guild-a", "first in alpha", "shared-user"))).type).toBe(5);
    expect((await handleInteraction(db, report("guild-a", "second in alpha", "shared-user"))).type).toBe(4);
    expect((await handleInteraction(db, report("guild-b", "first in beta", "shared-user"))).type).toBe(5);

    await db.delete(schema.commandConfigs);
  });

  it("/status reports only the asking server's numbers", async () => {
    const statusFor = async (guildId: string) => {
      const response = await handleInteraction(db, {
        id: `ms-status-${++counter}`,
        application_id: "app-1",
        type: 2,
        token: "t",
        guild_id: guildId,
        member: { user: { id: "nobody", username: "nobody" } },
        data: { name: "status" },
      });
      return response.data?.content ?? "";
    };

    const [a, b] = [await statusFor("guild-a"), await statusFor("guild-b")];
    expect(a).toContain("<#alpha-reports>");
    expect(a).not.toContain("beta-reports");
    expect(b).toContain("<#beta-reports>");
    expect(b).not.toContain("alpha-reports");
    expect(a).toMatch(/Mirror: slack/);
    expect(b).toMatch(/Mirror: discord/);
  });
});

describe("the dashboard's data is per server", () => {
  it("the live log shows only that server's commands, including rule matches", async () => {
    const a = report("guild-a", "another outage");
    const b = report("guild-b", "unrelated");
    await handleInteraction(db, a);
    await handleInteraction(db, b);

    const alpha = await getRecentInteractions(db, "guild-a");
    const beta = await getRecentInteractions(db, "guild-b");

    expect(alpha.some((i) => i.id === a.id)).toBe(true);
    expect(alpha.some((i) => i.id === b.id)).toBe(false);
    expect(beta.some((i) => i.id === b.id)).toBe(true);
    expect(beta.some((i) => i.id === a.id)).toBe(false);

    expect(alpha.find((i) => i.id === a.id)?.ruleMatches[0]).toMatch(/outage/);
    expect(beta.find((i) => i.id === b.id)?.ruleMatches).toEqual([]);
  });

  it("deleting a server removes its configuration but not the other server's", async () => {
    await db.insert(schema.guilds).values({ id: "guild-temp", name: "Temp" });
    await db.insert(schema.rules).values({
      guildId: "guild-temp",
      command: "report",
      condition: { type: "always" },
      actions: [{ type: "skip_mirror" }],
    });

    const alphaRulesBefore = await db.query.rules.findMany({ where: (r, { eq }) => eq(r.guildId, "guild-a") });
    await db.delete(schema.guilds).where(eq(schema.guilds.id, "guild-temp"));

    expect(await db.query.rules.findMany({ where: (r, { eq }) => eq(r.guildId, "guild-temp") })).toEqual([]);
    expect(await db.query.rules.findMany({ where: (r, { eq }) => eq(r.guildId, "guild-a") })).toEqual(alphaRulesBefore);
  });
});
