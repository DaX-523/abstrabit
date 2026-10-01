import { describe, expect, it } from "vitest";
import {
  ActionsSchema,
  ConditionSchema,
  STARTER_RULES,
  conditionMatches,
  describeRule,
  evaluateRules,
  parseKeywords,
  type RuleLike,
} from "@/lib/rules";

let n = 0;
function rule(partial: Partial<RuleLike> & Pick<RuleLike, "condition" | "actions">): RuleLike {
  return { id: `rule-${++n}`, position: 0, enabled: true, ...partial };
}

const high = [{ type: "set_priority", value: "high" }];

describe("conditions", () => {
  it("'always' matches anything", () => {
    expect(conditionMatches({ type: "always" }, "")).toBe(true);
  });

  it("text_contains is case-insensitive and matches any comma-separated keyword", () => {
    const c = { type: "text_contains", value: "Urgent, outage" } as const;
    expect(conditionMatches(c, "this is URGENT please")).toBe(true);
    expect(conditionMatches(c, "a full Outage")).toBe(true);
    expect(conditionMatches(c, "the printer is jammed")).toBe(false);
  });

  it("ignores empty keywords produced by stray commas", () => {
    expect(parseKeywords(" a, ,b,, ")).toEqual(["a", "b"]);
    expect(conditionMatches({ type: "text_contains", value: " , " }, "anything")).toBe(false);
  });

  it("rejects malformed stored conditions at the schema", () => {
    expect(ConditionSchema.safeParse({ type: "text_contains", value: "" }).success).toBe(false);
    expect(ConditionSchema.safeParse({ type: "text_contains", value: "x".repeat(101) }).success).toBe(false);
    expect(ConditionSchema.safeParse({ type: "nonsense" }).success).toBe(false);
  });
});

describe("actions schema", () => {
  it("accepts the supported actions", () => {
    expect(ActionsSchema.safeParse([{ type: "set_priority", value: "low" }, { type: "skip_mirror" }]).success).toBe(true);
  });

  it("rejects an unknown priority, an empty list, and an over-long note", () => {
    expect(ActionsSchema.safeParse([{ type: "set_priority", value: "urgent" }]).success).toBe(false);
    expect(ActionsSchema.safeParse([]).success).toBe(false);
    expect(ActionsSchema.safeParse([{ type: "reply_note", text: "x".repeat(201) }]).success).toBe(false);
  });
});

describe("evaluateRules", () => {
  it("defaults to medium priority with nothing matched when there are no rules", () => {
    expect(evaluateRules([], "anything")).toEqual({ priority: "medium", skipMirror: false, notes: [], matched: [] });
  });

  it("applies a matching rule's priority and records the match", () => {
    const r = rule({ condition: { type: "text_contains", value: "outage" }, actions: high });
    const out = evaluateRules([r], "full outage in prod");
    expect(out.priority).toBe("high");
    expect(out.matched).toEqual([{ id: r.id, summary: "Text contains “outage” → set priority to high" }]);
  });

  it("leaves non-matching rules alone", () => {
    const r = rule({ condition: { type: "text_contains", value: "outage" }, actions: high });
    expect(evaluateRules([r], "a typo in the docs").matched).toEqual([]);
  });

  it("runs rules in position order, so a later matching rule overrides an earlier priority", () => {
    const early = rule({ position: 0, condition: { type: "always" }, actions: high });
    const late = rule({ position: 1, condition: { type: "always" }, actions: [{ type: "set_priority", value: "low" }] });
    // Passed out of order on purpose.
    expect(evaluateRules([late, early], "x").priority).toBe("low");
  });

  it("skips disabled rules", () => {
    const off = rule({ enabled: false, condition: { type: "always" }, actions: high });
    expect(evaluateRules([off], "x").priority).toBe("medium");
  });

  it("collects skip_mirror and reply notes", () => {
    const r = rule({
      condition: { type: "always" },
      actions: [{ type: "skip_mirror" }, { type: "reply_note", text: "We'll look soon." }],
    });
    const out = evaluateRules([r], "x");
    expect(out.skipMirror).toBe(true);
    expect(out.notes).toEqual(["We'll look soon."]);
  });

  it("caps the number of reply notes", () => {
    const rules = Array.from({ length: 8 }, (_, i) =>
      rule({ position: i, condition: { type: "always" }, actions: [{ type: "reply_note", text: `note ${i}` }] }),
    );
    expect(evaluateRules(rules, "x").notes).toHaveLength(5);
  });

  it("silently skips a rule whose stored jsonb is malformed instead of throwing", () => {
    const bad = rule({ condition: { type: "text_contains" }, actions: "not an array" });
    const good = rule({ position: 1, condition: { type: "always" }, actions: high });
    expect(evaluateRules([bad, good], "x").priority).toBe("high");
  });
});

describe("starter rules", () => {
  it("are valid, and escalate an urgent report while de-prioritising a typo", () => {
    const rules = STARTER_RULES.map((r, i) => rule({ position: i, condition: r.condition, actions: r.actions }));
    expect(evaluateRules(rules, "URGENT: login is down, security issue").priority).toBe("high");
    expect(evaluateRules(rules, "small typo on the about page").priority).toBe("low");
    expect(evaluateRules(rules, "the printer is jammed").priority).toBe("medium");
  });

  it("describe themselves for the UI", () => {
    const [first] = STARTER_RULES;
    expect(describeRule(first.condition, first.actions)).toContain("set priority to high");
  });
});
