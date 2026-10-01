import { eq } from "drizzle-orm";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestDb } from "../helpers/testDb";
import { schema } from "@/db";
import type { Database } from "@/db";
import { decrypt } from "@/lib/crypto";
import { handleInteraction } from "@/lib/interactions/handle";

let db: Database;
let close: () => Promise<void>;

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  ({ db, close } = await createTestDb());
});

afterAll(async () => {
  await close();
});

let counter = 0;

/** A fully connected server: report channel + mirror, so every job kind is possible. */
async function connectedGuild(): Promise<string> {
  const id = `cfg-guild-${++counter}`;
  await db.insert(schema.guilds).values({
    id,
    name: id,
    reportChannelId: "chan-reports",
    mirrorKind: "slack",
    mirrorUrlEnc: "ciphertext-not-read-by-planning",
  });
  return id;
}

function slash(guildId: string, text: string | undefined, userId = "user-1") {
  const id = `cfg-interaction-${++counter}`;
  return {
    id,
    application_id: "app-1",
    type: 2,
    token: `token-${id}`,
    guild_id: guildId,
    channel_id: "chan-1",
    member: { user: { id: userId, username: `name-${userId}` } },
    data: { name: "report", options: text === undefined ? [] : [{ name: "text", value: text }] },
  };
}

function status(guildId: string) {
  const id = `cfg-interaction-${++counter}`;
  return {
    id,
    application_id: "app-1",
    type: 2,
    token: `token-${id}`,
    guild_id: guildId,
    member: { user: { id: "user-1", username: "alice" } },
    data: { name: "status" },
  };
}

function modalSubmit(guildId: string, fields: Record<string, string>, customId = "report_modal") {
  const id = `cfg-interaction-${++counter}`;
  return {
    id,
    application_id: "app-1",
    type: 5,
    token: `token-${id}`,
    guild_id: guildId,
    member: { user: { id: "user-1", username: "alice" } },
    data: {
      custom_id: customId,
      components: Object.entries(fields).map(([custom_id, value]) => ({
        type: 1,
        components: [{ type: 4, custom_id, value }],
      })),
    },
  };
}

async function jobKinds(interactionId: string): Promise<string[]> {
  const jobs = await db.query.jobs.findMany({ where: (j, { eq }) => eq(j.interactionId, interactionId) });
  return jobs.map((j) => j.kind).sort();
}

async function reportFor(interactionId: string) {
  return db.query.reports.findFirst({ where: (r, { eq }) => eq(r.interactionId, interactionId) });
}

async function setConfig(guildId: string, command: string, values: Partial<typeof schema.commandConfigs.$inferInsert>) {
  await db.insert(schema.commandConfigs).values({ guildId, command, ...values });
}

async function addRule(
  guildId: string,
  condition: unknown,
  actions: unknown,
  extra: Partial<typeof schema.rules.$inferInsert> = {},
) {
  await db.insert(schema.rules).values({ guildId, command: "report", condition, actions, ...extra });
}

describe("rules applied by /report", () => {
  it("sets the priority from a matching rule and records which rule fired", async () => {
    const guildId = await connectedGuild();
    await addRule(guildId, { type: "text_contains", value: "outage" }, [{ type: "set_priority", value: "high" }]);

    const payload = slash(guildId, "Full OUTAGE on checkout");
    await handleInteraction(db, payload);

    expect((await reportFor(payload.id))?.priority).toBe("high");
    const interaction = await db.query.interactions.findFirst({ where: (i, { eq }) => eq(i.id, payload.id) });
    expect(interaction?.ruleMatches).toEqual([
      expect.objectContaining({ summary: "Text contains “outage” → set priority to high" }),
    ]);
  });

  it("leaves the default priority when no rule matches", async () => {
    const guildId = await connectedGuild();
    await addRule(guildId, { type: "text_contains", value: "outage" }, [{ type: "set_priority", value: "high" }]);

    const payload = slash(guildId, "the printer is jammed");
    await handleInteraction(db, payload);

    expect((await reportFor(payload.id))?.priority).toBe("medium");
  });

  it("skip_mirror suppresses the mirror job but not the channel post or reply", async () => {
    const guildId = await connectedGuild();
    await addRule(guildId, { type: "text_contains", value: "internal" }, [{ type: "skip_mirror" }]);

    const payload = slash(guildId, "internal only: salary question");
    await handleInteraction(db, payload);

    expect(await jobKinds(payload.id)).toEqual(["channel_post", "reply"]);
  });

  it("passes reply notes to the reply job", async () => {
    const guildId = await connectedGuild();
    await addRule(guildId, { type: "always" }, [{ type: "reply_note", text: "An admin will look within the hour." }]);

    const payload = slash(guildId, "hello");
    await handleInteraction(db, payload);

    const reply = (await db.query.jobs.findMany({ where: (j, { eq }) => eq(j.interactionId, payload.id) })).find(
      (j) => j.kind === "reply",
    );
    expect(JSON.parse(decrypt(reply!.payloadEnc)).notes).toEqual(["An admin will look within the hour."]);
  });

  it("ignores disabled rules", async () => {
    const guildId = await connectedGuild();
    await addRule(guildId, { type: "always" }, [{ type: "set_priority", value: "critical" }], { enabled: false });

    const payload = slash(guildId, "x");
    await handleInteraction(db, payload);
    expect((await reportFor(payload.id))?.priority).toBe("medium");
  });
});

describe("command configuration for /report", () => {
  it("does nothing but say it's off when disabled (the interaction is still recorded)", async () => {
    const guildId = await connectedGuild();
    await setConfig(guildId, "report", { enabled: false });

    const payload = slash(guildId, "hello");
    const response = await handleInteraction(db, payload);

    expect(response.data?.content).toMatch(/turned off/i);
    expect(await reportFor(payload.id)).toBeUndefined();
    expect(await jobKinds(payload.id)).toEqual([]);
    expect(await db.query.interactions.findFirst({ where: (i, { eq }) => eq(i.id, payload.id) })).toBeDefined();
  });

  it("skips the channel post when postToChannel is off, and the mirror when mirror is off", async () => {
    const guildId = await connectedGuild();
    await setConfig(guildId, "report", { postToChannel: false, mirror: false });

    const payload = slash(guildId, "hello");
    await handleInteraction(db, payload);
    expect(await jobKinds(payload.id)).toEqual(["reply"]);
  });

  it("defers publicly (no ephemeral flag) when ephemeral is off", async () => {
    const guildId = await connectedGuild();
    await setConfig(guildId, "report", { ephemeral: false });

    const response = await handleInteraction(db, slash(guildId, "hello"));
    expect(response.type).toBe(5);
    expect(response.data?.flags).toBeUndefined();
  });

  it("gives channel posts and mirrors a day to retry, but the reply only until its token expires", async () => {
    const guildId = await connectedGuild();
    const payload = slash(guildId, "hello");
    await handleInteraction(db, payload);

    const jobs = await db.query.jobs.findMany({ where: (j, { eq }) => eq(j.interactionId, payload.id) });
    const hoursLeft = (kind: string) =>
      (jobs.find((j) => j.kind === kind)!.deadline!.getTime() - Date.now()) / 3_600_000;
    expect(hoursLeft("mirror")).toBeGreaterThan(23);
    expect(hoursLeft("channel_post")).toBeGreaterThan(23);
    expect(hoursLeft("reply")).toBeLessThan(0.25);
  });

  it("with the form turned off, /report without text asks for text instead of opening a modal", async () => {
    const guildId = await connectedGuild();
    await setConfig(guildId, "report", { modalWhenEmpty: false });

    const response = await handleInteraction(db, slash(guildId, undefined));
    expect(response.type).toBe(4);
    expect(response.data?.content).toMatch(/include some text/i);
  });
});

describe("rate limit", () => {
  it("rejects a person's reports beyond the limit, without affecting other people", async () => {
    const guildId = await connectedGuild();
    await setConfig(guildId, "report", { cooldownCount: 2, cooldownWindowSeconds: 60 });

    const first = slash(guildId, "one");
    const second = slash(guildId, "two");
    const third = slash(guildId, "three");
    const otherPerson = slash(guildId, "four", "user-2");

    expect((await handleInteraction(db, first)).type).toBe(5);
    expect((await handleInteraction(db, second)).type).toBe(5);

    const blocked = await handleInteraction(db, third);
    expect(blocked.type).toBe(4);
    expect(blocked.data?.content).toMatch(/allows 2/);
    expect(await reportFor(third.id)).toBeUndefined();

    expect((await handleInteraction(db, otherPerson)).type).toBe(5);
  });

  it("counts only reports inside the window", async () => {
    const guildId = await connectedGuild();
    await setConfig(guildId, "report", { cooldownCount: 1, cooldownWindowSeconds: 60 });

    const old = slash(guildId, "old");
    await handleInteraction(db, old);
    await db
      .update(schema.reports)
      .set({ createdAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(schema.reports.interactionId, old.id));

    expect((await handleInteraction(db, slash(guildId, "new"))).type).toBe(5);
  });

  it("is off by default", async () => {
    const guildId = await connectedGuild();
    for (let i = 0; i < 4; i++) {
      expect((await handleInteraction(db, slash(guildId, `r${i}`))).type).toBe(5);
    }
  });
});

describe("the /report modal", () => {
  it("is opened by /report without text, with a title and a details field", async () => {
    const guildId = await connectedGuild();
    const response = await handleInteraction(db, slash(guildId, undefined));

    expect(response.type).toBe(9);
    expect(response.data?.title).toBeTruthy();
    const fieldIds = (response.data?.components as Array<{ components: Array<{ custom_id: string }> }>).flatMap((row) =>
      row.components.map((c) => c.custom_id),
    );
    expect(fieldIds).toEqual(["title", "details"]);
  });

  it("files a report from the submitted form and runs it through the same pipeline", async () => {
    const guildId = await connectedGuild();
    await addRule(guildId, { type: "text_contains", value: "checkout" }, [{ type: "set_priority", value: "high" }]);

    const payload = modalSubmit(guildId, { title: "Checkout is down", details: "Customers can't pay." });
    const response = await handleInteraction(db, payload);

    expect(response.type).toBe(5);
    const report = await reportFor(payload.id);
    expect(report).toMatchObject({ title: "Checkout is down", body: "Customers can't pay.", priority: "high" });
    expect(await jobKinds(payload.id)).toEqual(["channel_post", "mirror", "reply"]);

    const interaction = await db.query.interactions.findFirst({ where: (i, { eq }) => eq(i.id, payload.id) });
    expect(interaction?.inputText).toBe("Customers can't pay.");
  });

  it("also reads values from the label-based modal layout", async () => {
    const guildId = await connectedGuild();
    const payload = {
      ...modalSubmit(guildId, {}),
      data: {
        custom_id: "report_modal",
        components: [
          { type: 18, component: { type: 4, custom_id: "title", value: "T" } },
          { type: 18, component: { type: 4, custom_id: "details", value: "From labels" } },
        ],
      },
    };
    await handleInteraction(db, payload);
    expect(await reportFor(payload.id)).toMatchObject({ title: "T", body: "From labels" });
  });

  it("does not file an empty form", async () => {
    const guildId = await connectedGuild();
    const payload = modalSubmit(guildId, { title: "Just a title", details: "   " });
    const response = await handleInteraction(db, payload);

    expect(response.type).toBe(4);
    expect(await reportFor(payload.id)).toBeUndefined();
  });

  it("rejects a form it doesn't know", async () => {
    const guildId = await connectedGuild();
    const payload = modalSubmit(guildId, { details: "x" }, "some_other_modal");
    const response = await handleInteraction(db, payload);

    expect(response.data?.content).toMatch(/unknown form/i);
    expect(await reportFor(payload.id)).toBeUndefined();
  });

  it("respects /report being disabled, even for a form that was already open", async () => {
    const guildId = await connectedGuild();
    await setConfig(guildId, "report", { enabled: false });

    const payload = modalSubmit(guildId, { title: "t", details: "d" });
    const response = await handleInteraction(db, payload);
    expect(response.data?.content).toMatch(/turned off/i);
    expect(await reportFor(payload.id)).toBeUndefined();
  });

  it("is deduplicated like any other interaction: the same submit twice files one report", async () => {
    const guildId = await connectedGuild();
    const payload = modalSubmit(guildId, { title: "t", details: "d" });
    const [a, b] = await Promise.all([handleInteraction(db, payload), handleInteraction(db, payload)]);

    expect(a).toEqual(b);
    const reports = await db.query.reports.findMany({ where: (r, { eq }) => eq(r.interactionId, payload.id) });
    expect(reports).toHaveLength(1);
  });
});

describe("command configuration for /status", () => {
  it("replies that it's off when disabled", async () => {
    const guildId = await connectedGuild();
    await setConfig(guildId, "status", { enabled: false });

    const response = await handleInteraction(db, status(guildId));
    expect(response.data?.content).toMatch(/turned off/i);
  });

  it("replies publicly when ephemeral is off", async () => {
    const guildId = await connectedGuild();
    await setConfig(guildId, "status", { ephemeral: false });

    const response = await handleInteraction(db, status(guildId));
    expect(response.data?.content).toMatch(/Connected/);
    expect(response.data?.flags).toBeUndefined();
  });

  it("is private by default", async () => {
    const guildId = await connectedGuild();
    const response = await handleInteraction(db, status(guildId));
    expect(response.data?.flags).toBe(64);
  });
});
