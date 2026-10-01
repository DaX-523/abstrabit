import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * The server actions behind the Commands and Failures tabs. Focus: every
 * action is authorized per-guild on the server, and an admin of one server
 * can never read or change another server's rules, config or jobs by
 * submitting a forged form (their own guildId with someone else's rule/job id).
 */

const { FakeRedirectError, redirectMock, afterMock } = vi.hoisted(() => {
  class FakeRedirectError extends Error {
    constructor(public url: string) {
      super("NEXT_REDIRECT");
    }
  }
  return {
    FakeRedirectError,
    redirectMock: vi.fn((url: string) => {
      throw new FakeRedirectError(url);
    }),
    afterMock: vi.fn(),
  };
});

vi.mock("next/navigation", () => ({ redirect: redirectMock }));
vi.mock("next/server", () => ({ after: afterMock }));

const cookieStore = new Map<string, { value: string }>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => cookieStore.get(name),
    set: (name: string, value: string) => cookieStore.set(name, { value }),
    delete: (name: string) => cookieStore.delete(name),
    has: (name: string) => cookieStore.has(name),
  }),
}));

import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/testDb";
import { schema } from "@/db";
import type { Database } from "@/db";
import { AuthError, createSession, setSessionCookie } from "@/lib/auth";
import { enqueueJob } from "@/lib/jobs/queue";
import * as commands from "@/app/dashboard/[guildId]/commands/actions";
import * as failures from "@/app/dashboard/[guildId]/failures/actions";

let db: Database;
let close: () => Promise<void>;

vi.mock("@/db", async () => {
  const actual = await vi.importActual<typeof import("@/db")>("@/db");
  return { ...actual, getDb: () => db };
});

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 12).toString("base64");
  process.env.DISCORD_APPLICATION_ID = "app-id";
  process.env.DISCORD_PUBLIC_KEY = "a".repeat(64);
  process.env.DISCORD_BOT_TOKEN = "bot-token-value";
  process.env.DISCORD_CLIENT_SECRET = "client-secret";
  process.env.DISCORD_OAUTH_REDIRECT_URI = "http://localhost:3000/api/discord/oauth/callback";
  process.env.GROQ_API_KEY = "groq-key";
  process.env.CRON_SECRET = "a".repeat(20);
  process.env.SESSION_SECRET = "b".repeat(20);
  process.env.APP_BASE_URL = "http://localhost:3000";

  cookieStore.clear();
  redirectMock.mockClear();
  afterMock.mockClear();
  ({ db, close } = await createTestDb());

  // Alice administers guild-a only; guild-b belongs to someone else.
  const [alice] = await db.insert(schema.users).values({ email: "alice@example.com", passwordHash: "x" }).returning();
  const [bob] = await db.insert(schema.users).values({ email: "bob@example.com", passwordHash: "x" }).returning();
  await db.insert(schema.guilds).values([
    { id: "guild-a", name: "A" },
    { id: "guild-b", name: "B" },
  ]);
  await db.insert(schema.guildAdmins).values([
    { guildId: "guild-a", userId: alice.id },
    { guildId: "guild-b", userId: bob.id },
  ]);
  await setSessionCookie(await createSession(db, alice.id));
});

afterEach(async () => {
  await close();
});

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

/** Runs an action that ends in redirect(), returning the URL it redirected to. */
async function run(action: (fd: FormData) => Promise<void>, fields: Record<string, string>): Promise<string> {
  redirectMock.mockClear();
  await expect(action(form(fields))).rejects.toBeInstanceOf(FakeRedirectError);
  expect(redirectMock).toHaveBeenCalledTimes(1);
  return redirectMock.mock.calls[0][0] as string;
}

async function addRuleRow(guildId: string, position: number, extra: Partial<typeof schema.rules.$inferInsert> = {}) {
  const [row] = await db
    .insert(schema.rules)
    .values({
      guildId,
      command: "report",
      position,
      condition: { type: "always" },
      actions: [{ type: "set_priority", value: "high" }],
      ...extra,
    })
    .returning();
  return row;
}

const rulesOf = (guildId: string) =>
  db.query.rules.findMany({ where: (r, { eq }) => eq(r.guildId, guildId), orderBy: (r, { asc }) => [asc(r.position), asc(r.id)] });

describe("authorization", () => {
  it.each([
    ["updateCommandConfigAction", commands.updateCommandConfigAction, { command: "report" }],
    ["addRuleAction", commands.addRuleAction, { keywords: "x", actionType: "skip_mirror" }],
    ["addStarterRulesAction", commands.addStarterRulesAction, {}],
    ["toggleRuleAction", commands.toggleRuleAction, { ruleId: "x" }],
    ["deleteRuleAction", commands.deleteRuleAction, { ruleId: "x" }],
    ["moveRuleAction", commands.moveRuleAction, { ruleId: "x", direction: "up" }],
    ["retryJobAction", failures.retryJobAction, { jobId: "x" }],
  ] as const)("%s refuses a server the user doesn't administer", async (_name, action, fields) => {
    await expect(action(form({ guildId: "guild-b", ...fields }))).rejects.toBeInstanceOf(AuthError);
    expect(redirectMock).not.toHaveBeenCalled();
    expect(await db.query.commandConfigs.findMany()).toEqual([]);
    expect(await db.query.rules.findMany()).toEqual([]);
  });

  it("refuses a signed-out request", async () => {
    cookieStore.clear();
    await expect(commands.addStarterRulesAction(form({ guildId: "guild-a" }))).rejects.toBeInstanceOf(AuthError);
    expect(await db.query.rules.findMany()).toEqual([]);
  });
});

describe("updateCommandConfigAction", () => {
  it("saves a command's settings (creating the row if the server never had one)", async () => {
    const url = await run(commands.updateCommandConfigAction, {
      guildId: "guild-a",
      command: "report",
      enabled: "on",
      mirror: "on",
      cooldownCount: "3",
      cooldownWindowSeconds: "120",
      // ephemeral, modalWhenEmpty and postToChannel are unchecked -> false
    });

    expect(url).toContain("success=");
    const config = await db.query.commandConfigs.findFirst({ where: (c, { eq }) => eq(c.guildId, "guild-a") });
    expect(config).toMatchObject({
      command: "report",
      enabled: true,
      ephemeral: false,
      modalWhenEmpty: false,
      postToChannel: false,
      mirror: true,
      cooldownCount: 3,
      cooldownWindowSeconds: 120,
    });
  });

  it("updates an existing row rather than duplicating it", async () => {
    await db.insert(schema.commandConfigs).values({ guildId: "guild-a", command: "status" });
    await run(commands.updateCommandConfigAction, { guildId: "guild-a", command: "status", enabled: "on" });
    await run(commands.updateCommandConfigAction, { guildId: "guild-a", command: "status", ephemeral: "on" });

    const rows = await db.query.commandConfigs.findMany({ where: (c, { eq }) => eq(c.guildId, "guild-a") });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ enabled: false, ephemeral: true });
  });

  it("rejects an unknown command and out-of-range numbers, saving nothing", async () => {
    expect(await run(commands.updateCommandConfigAction, { guildId: "guild-a", command: "ban" })).toContain("error=");
    expect(
      await run(commands.updateCommandConfigAction, {
        guildId: "guild-a",
        command: "report",
        cooldownCount: "-1",
        cooldownWindowSeconds: "60",
      }),
    ).toContain("error=");
    expect(
      await run(commands.updateCommandConfigAction, {
        guildId: "guild-a",
        command: "report",
        cooldownCount: "2",
        cooldownWindowSeconds: "5",
      }),
    ).toContain("error=");
    expect(await db.query.commandConfigs.findMany()).toEqual([]);
  });
});

describe("rule actions", () => {
  it("adds a keyword rule at the end of the list", async () => {
    await addRuleRow("guild-a", 4);
    const url = await run(commands.addRuleAction, {
      guildId: "guild-a",
      keywords: "outage, urgent",
      actionType: "set_priority",
      priority: "critical",
    });

    expect(url).toContain("success=");
    const rules = await rulesOf("guild-a");
    expect(rules).toHaveLength(2);
    expect(rules[1]).toMatchObject({
      position: 5,
      command: "report",
      enabled: true,
      condition: { type: "text_contains", value: "outage, urgent" },
      actions: [{ type: "set_priority", value: "critical" }],
    });
  });

  it("treats empty keywords as 'every report'", async () => {
    await run(commands.addRuleAction, { guildId: "guild-a", keywords: "  ", actionType: "skip_mirror" });
    expect((await rulesOf("guild-a"))[0]).toMatchObject({ condition: { type: "always" }, actions: [{ type: "skip_mirror" }] });
  });

  it("adds a reply-note rule", async () => {
    await run(commands.addRuleAction, { guildId: "guild-a", keywords: "", actionType: "reply_note", note: "Thanks!" });
    expect((await rulesOf("guild-a"))[0].actions).toEqual([{ type: "reply_note", text: "Thanks!" }]);
  });

  it.each([
    ["an unknown priority", { actionType: "set_priority", priority: "apocalyptic" }],
    ["an empty note", { actionType: "reply_note", note: "   " }],
    ["an over-long note", { actionType: "reply_note", note: "x".repeat(201) }],
    ["an unknown action", { actionType: "delete_everything" }],
    ["over-long keywords", { actionType: "skip_mirror", keywords: "k".repeat(101) }],
  ])("rejects %s and stores nothing", async (_label, fields) => {
    const url = await run(commands.addRuleAction, { guildId: "guild-a", ...fields });
    expect(url).toContain("error=");
    expect(await rulesOf("guild-a")).toEqual([]);
  });

  it("stops at 20 rules", async () => {
    for (let i = 0; i < 20; i++) await addRuleRow("guild-a", i);
    const url = await run(commands.addRuleAction, { guildId: "guild-a", keywords: "", actionType: "skip_mirror" });
    expect(url).toContain("error=");
    expect(await rulesOf("guild-a")).toHaveLength(20);
  });

  it("adds the starter rules once, only to an empty server", async () => {
    expect(await run(commands.addStarterRulesAction, { guildId: "guild-a" })).toContain("success=");
    expect((await rulesOf("guild-a")).length).toBeGreaterThanOrEqual(2);

    const before = (await rulesOf("guild-a")).length;
    expect(await run(commands.addStarterRulesAction, { guildId: "guild-a" })).toContain("error=");
    expect(await rulesOf("guild-a")).toHaveLength(before);
  });

  it("toggles a rule on and off", async () => {
    const rule = await addRuleRow("guild-a", 0);
    await run(commands.toggleRuleAction, { guildId: "guild-a", ruleId: rule.id });
    expect((await rulesOf("guild-a"))[0].enabled).toBe(false);
    await run(commands.toggleRuleAction, { guildId: "guild-a", ruleId: rule.id });
    expect((await rulesOf("guild-a"))[0].enabled).toBe(true);
  });

  it("deletes a rule", async () => {
    const rule = await addRuleRow("guild-a", 0);
    expect(await run(commands.deleteRuleAction, { guildId: "guild-a", ruleId: rule.id })).toContain("success=");
    expect(await rulesOf("guild-a")).toEqual([]);
  });

  it("moves a rule up and down, even when positions have duplicates", async () => {
    const first = await addRuleRow("guild-a", 0);
    const second = await addRuleRow("guild-a", 0); // duplicate position on purpose
    const third = await addRuleRow("guild-a", 5);
    const idsInOrder = async () => (await rulesOf("guild-a")).map((r) => r.id);
    const start = await idsInOrder();
    expect(new Set(start)).toEqual(new Set([first.id, second.id, third.id]));

    await run(commands.moveRuleAction, { guildId: "guild-a", ruleId: start[2], direction: "up" });
    expect(await idsInOrder()).toEqual([start[0], start[2], start[1]]);

    await run(commands.moveRuleAction, { guildId: "guild-a", ruleId: start[2], direction: "down" });
    expect(await idsInOrder()).toEqual(start);
  });

  it("refuses to move the first rule up", async () => {
    const rule = await addRuleRow("guild-a", 0);
    expect(await run(commands.moveRuleAction, { guildId: "guild-a", ruleId: rule.id, direction: "up" })).toContain("error=");
  });
});

describe("one server's admin can't touch another server's rules (forged ruleId)", () => {
  it("toggle, delete and move all say 'not found' and leave the other server's rule alone", async () => {
    const theirs = await addRuleRow("guild-b", 0);
    const theirs2 = await addRuleRow("guild-b", 1);

    // Alice is admin of guild-a, so the guard passes; the rule belongs to guild-b.
    expect(await run(commands.toggleRuleAction, { guildId: "guild-a", ruleId: theirs.id })).toContain("error=");
    expect(await run(commands.deleteRuleAction, { guildId: "guild-a", ruleId: theirs.id })).toContain("error=");
    expect(await run(commands.moveRuleAction, { guildId: "guild-a", ruleId: theirs2.id, direction: "up" })).toContain(
      "error=",
    );

    const untouched = await rulesOf("guild-b");
    expect(untouched.map((r) => r.id)).toEqual([theirs.id, theirs2.id]);
    expect(untouched.every((r) => r.enabled)).toBe(true);
  });
});

describe("retryJobAction", () => {
  async function deadJob(guildId: string, kind: "mirror" | "reply" = "mirror") {
    const interactionId = `int-${guildId}-${kind}`;
    await db.insert(schema.interactions).values({ id: interactionId, guildId, type: 2, status: "completed" });
    await enqueueJob(db, { interactionId, kind, payload: {} });
    const job = (await db.query.jobs.findFirst({ where: (j, { eq }) => eq(j.interactionId, interactionId) }))!;
    await db.update(schema.jobs).set({ status: "dead", attempts: 3, lastError: "boom" }).where(eq(schema.jobs.id, job.id));
    return job.id;
  }

  it("re-queues the job and kicks off a run right after responding", async () => {
    const id = await deadJob("guild-a");

    const url = await run(failures.retryJobAction, { guildId: "guild-a", jobId: id });

    expect(url).toContain("success=");
    expect((await db.query.jobs.findFirst({ where: (j, { eq }) => eq(j.id, id) }))?.status).toBe("pending");
    expect(afterMock).toHaveBeenCalledTimes(1);
  });

  it("refuses another server's job, without running anything", async () => {
    const id = await deadJob("guild-b");

    const url = await run(failures.retryJobAction, { guildId: "guild-a", jobId: id });

    expect(url).toContain("error=");
    expect((await db.query.jobs.findFirst({ where: (j, { eq }) => eq(j.id, id) }))?.status).toBe("dead");
    expect(afterMock).not.toHaveBeenCalled();
  });

  it("explains when a reply can't be retried because its token expired", async () => {
    const id = await deadJob("guild-a", "reply");
    await db.update(schema.jobs).set({ deadline: new Date(Date.now() - 1000) }).where(eq(schema.jobs.id, id));

    const url = await run(failures.retryJobAction, { guildId: "guild-a", jobId: id });

    expect(decodeURIComponent(url)).toMatch(/15-minute/);
    expect(afterMock).not.toHaveBeenCalled();
  });
});
