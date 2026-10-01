import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestDb } from "../helpers/testDb";
import { schema } from "@/db";
import type { Database } from "@/db";
import { handleInteraction } from "@/lib/interactions/handle";
import type { InteractionResponseBody } from "@/lib/discord/types";

let db: Database;
let close: () => Promise<void>;

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
  ({ db, close } = await createTestDb());
});

afterAll(async () => {
  await close();
});

let counter = 0;
function reportInteraction(overrides: Record<string, unknown> = {}) {
  const id = `report-interaction-${++counter}`;
  return {
    id,
    application_id: "app-1",
    type: 2,
    token: `token-${id}`,
    guild_id: "guild-report-1",
    channel_id: "channel-1",
    member: { user: { id: "user-1", username: "alice" } },
    data: { name: "report", options: [{ name: "text", value: "the printer is on fire" }] },
    ...overrides,
  };
}

describe("handleInteraction: /report", () => {
  it("records the interaction and report, and defers the response", async () => {
    const payload = reportInteraction();
    const response = await handleInteraction(db, payload);
    expect(response.type).toBe(5); // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
    expect(response.data?.flags).toBe(64); // ephemeral

    const interaction = await db.query.interactions.findFirst({
      where: (i, { eq }) => eq(i.id, payload.id),
    });
    expect(interaction).toBeDefined();
    expect(interaction?.status).toBe("completed");

    const report = await db.query.reports.findFirst({
      where: (r, { eq }) => eq(r.interactionId, payload.id),
    });
    expect(report?.body).toBe("the printer is on fire");
    expect(report?.priority).toBe("medium");
  });

  it("always enqueues a reply job, even with no channel/mirror configured", async () => {
    const payload = reportInteraction();
    await handleInteraction(db, payload);
    const jobs = await db.query.jobs.findMany({ where: (j, { eq }) => eq(j.interactionId, payload.id) });
    expect(jobs.map((j) => j.kind)).toEqual(["reply"]);
  });

  it("also enqueues channel_post and mirror when the guild has them configured", async () => {
    await db.insert(schema.guilds).values({
      id: "guild-report-configured",
      name: "Configured Guild",
      reportChannelId: "channel-reports",
      mirrorKind: "slack",
      mirrorUrlEnc: "irrelevant-ciphertext-for-this-test",
    });
    const payload = reportInteraction({ guild_id: "guild-report-configured" });
    await handleInteraction(db, payload);
    const jobs = await db.query.jobs.findMany({ where: (j, { eq }) => eq(j.interactionId, payload.id) });
    expect(new Set(jobs.map((j) => j.kind))).toEqual(new Set(["reply", "channel_post", "mirror"]));
  });

  it("opens the report form (a modal) when no text is given, without creating a report", async () => {
    const payload = reportInteraction({ data: { name: "report", options: [] } });
    const response = await handleInteraction(db, payload);
    expect(response.type).toBe(9); // MODAL
    expect(response.data?.custom_id).toBe("report_modal");

    const report = await db.query.reports.findFirst({
      where: (r, { eq }) => eq(r.interactionId, payload.id),
    });
    expect(report).toBeUndefined();

    // The interaction itself is still recorded (dedup boundary applies
    // regardless of whether the command's own validation passed).
    const interaction = await db.query.interactions.findFirst({
      where: (i, { eq }) => eq(i.id, payload.id),
    });
    expect(interaction).toBeDefined();
  });
});

describe("handleInteraction: dedup on interaction id", () => {
  it("does not create a second report when the same interaction id is delivered twice sequentially", async () => {
    const payload = reportInteraction();
    const first = await handleInteraction(db, payload);
    const second = await handleInteraction(db, { ...payload, data: { name: "report", options: [{ name: "text", value: "a completely different body" }] } });

    expect(second).toEqual(first);

    const reports = await db.query.reports.findMany({ where: (r, { eq }) => eq(r.interactionId, payload.id) });
    expect(reports).toHaveLength(1);
    expect(reports[0].body).toBe("the printer is on fire"); // first delivery's text won, not the replay's

    const interaction = await db.query.interactions.findFirst({ where: (i, { eq }) => eq(i.id, payload.id) });
    expect(interaction?.duplicateCount).toBe(1);
  });

  it("does not create two reports when the same interaction id arrives concurrently", async () => {
    const payload = reportInteraction();
    const [a, b]: InteractionResponseBody[] = await Promise.all([
      handleInteraction(db, payload),
      handleInteraction(db, payload),
    ]);

    // Both callers must see the exact same (real) response -- neither one
    // should see a generic "still processing" placeholder, because by the
    // time either INSERT's conflict resolves, the winner has committed.
    expect(a).toEqual(b);
    expect(a.type).toBe(5);

    const reports = await db.query.reports.findMany({ where: (r, { eq }) => eq(r.interactionId, payload.id) });
    expect(reports).toHaveLength(1);

    const jobs = await db.query.jobs.findMany({ where: (j, { eq }) => eq(j.interactionId, payload.id) });
    expect(jobs).toHaveLength(1); // exactly one reply job, not two
  });

  it("rejects a malformed payload without touching the database", async () => {
    const response = await handleInteraction(db, { not: "a valid interaction" });
    expect(response.data?.content).toMatch(/malformed/i);
  });
});

describe("handleInteraction: /status", () => {
  it("tells the user the server isn't connected yet", async () => {
    const response = await handleInteraction(db, {
      id: "status-1",
      application_id: "app-1",
      type: 2,
      token: "token-status-1",
      guild_id: "guild-not-connected",
      member: { user: { id: "user-1", username: "alice" } },
      data: { name: "status" },
    });
    expect(response.data?.content).toMatch(/isn't connected/i);
  });

  it("summarizes open reports and the caller's recent reports for a connected guild", async () => {
    await db.insert(schema.guilds).values({
      id: "guild-status-1",
      name: "Status Guild",
      reportChannelId: "channel-x",
    });
    // Seed one open report from this same user via the real /report path so
    // the numbers status reports back are consistent with what /report did.
    const reportPayload = reportInteraction({ guild_id: "guild-status-1" });
    await handleInteraction(db, reportPayload);

    const response = await handleInteraction(db, {
      id: "status-2",
      application_id: "app-1",
      type: 2,
      token: "token-status-2",
      guild_id: "guild-status-1",
      member: { user: { id: "user-1", username: "alice" } },
      data: { name: "status" },
    });
    expect(response.data?.content).toMatch(/Open reports: 1/);
    expect(response.data?.content).toMatch(/the printer is on fire/);
  });
});
