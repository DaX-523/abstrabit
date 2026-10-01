import { z } from "zod";

/**
 * The rules engine: pure (no DB, no Discord), so it's trivially unit-testable.
 * An admin configures rules in the dashboard; `planReport` loads them and
 * calls `evaluateRules` on each new report.
 *
 * A rule is `condition` + `actions`. Rules run in `position` order and every
 * matching rule applies, so a later rule can override an earlier one's
 * `set_priority`.
 */

export const PRIORITIES = ["low", "medium", "high", "critical"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const DEFAULT_PRIORITY: Priority = "medium";

export const MAX_RULES_PER_COMMAND = 20;
const MAX_NOTES_PER_REPLY = 5;

export const ConditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("always") }),
  // `value` is one or more comma-separated keywords; the rule matches if the
  // report text contains ANY of them (case-insensitive).
  z.object({ type: z.literal("text_contains"), value: z.string().trim().min(1).max(100) }),
]);

export const ActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("set_priority"), value: z.enum(PRIORITIES) }),
  z.object({ type: z.literal("skip_mirror") }),
  // Shown to the user under the confirmation. Always sent with
  // allowed_mentions: { parse: [] }, so it can't ping anyone.
  z.object({ type: z.literal("reply_note"), text: z.string().trim().min(1).max(200) }),
]);

export const ActionsSchema = z.array(ActionSchema).min(1).max(5);

export type Condition = z.infer<typeof ConditionSchema>;
export type Action = z.infer<typeof ActionSchema>;

/** The shape of a `rules` row, with `condition`/`actions` left as untrusted jsonb. */
export interface RuleLike {
  id: string;
  position: number;
  enabled: boolean;
  condition: unknown;
  actions: unknown;
}

export interface RuleMatch {
  id: string;
  summary: string;
}

export interface RuleOutcome {
  priority: Priority;
  skipMirror: boolean;
  notes: string[];
  matched: RuleMatch[];
}

export function parseKeywords(value: string): string[] {
  return value
    .split(",")
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0);
}

export function conditionMatches(condition: Condition, text: string): boolean {
  if (condition.type === "always") return true;
  const haystack = text.toLowerCase();
  return parseKeywords(condition.value).some((k) => haystack.includes(k));
}

export function describeCondition(condition: Condition): string {
  if (condition.type === "always") return "Every report";
  return `Text contains ${parseKeywords(condition.value)
    .map((k) => `“${k}”`)
    .join(" or ")}`;
}

export function describeAction(action: Action): string {
  switch (action.type) {
    case "set_priority":
      return `set priority to ${action.value}`;
    case "skip_mirror":
      return "don't mirror";
    case "reply_note":
      return `add note “${action.text}”`;
  }
}

export function describeRule(condition: Condition, actions: Action[]): string {
  return `${describeCondition(condition)} → ${actions.map(describeAction).join(", ")}`;
}

/** Parses a stored rule's jsonb, or null if it's malformed (such rules are skipped, never fatal). */
export function parseRule(rule: RuleLike): { condition: Condition; actions: Action[] } | null {
  const condition = ConditionSchema.safeParse(rule.condition);
  const actions = ActionsSchema.safeParse(rule.actions);
  if (!condition.success || !actions.success) return null;
  return { condition: condition.data, actions: actions.data };
}

export function evaluateRules(rules: RuleLike[], text: string): RuleOutcome {
  const outcome: RuleOutcome = { priority: DEFAULT_PRIORITY, skipMirror: false, notes: [], matched: [] };

  const ordered = rules.filter((r) => r.enabled).sort((a, b) => a.position - b.position);
  for (const rule of ordered) {
    const parsed = parseRule(rule);
    if (!parsed || !conditionMatches(parsed.condition, text)) continue;

    outcome.matched.push({ id: rule.id, summary: describeRule(parsed.condition, parsed.actions) });
    for (const action of parsed.actions) {
      if (action.type === "set_priority") outcome.priority = action.value;
      else if (action.type === "skip_mirror") outcome.skipMirror = true;
      else if (outcome.notes.length < MAX_NOTES_PER_REPLY) outcome.notes.push(action.text);
    }
  }
  return outcome;
}

/** Offered to a new server's admin as a one-click starting point. */
export const STARTER_RULES: Array<{ condition: Condition; actions: Action[] }> = [
  {
    condition: { type: "text_contains", value: "urgent, outage, asap, crash, data loss, security" },
    actions: [{ type: "set_priority", value: "high" }],
  },
  {
    condition: { type: "text_contains", value: "typo, minor, suggestion, cosmetic" },
    actions: [{ type: "set_priority", value: "low" }],
  },
];
