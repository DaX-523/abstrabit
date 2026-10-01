import { redirect, notFound } from "next/navigation";
import { getDb } from "@/db";
import { requireGuildAdmin, AuthError } from "@/lib/auth";
import { getCommandConfig, type CommandName } from "@/lib/commandConfig";
import { describeAction, describeCondition, parseRule, MAX_RULES_PER_COMMAND, PRIORITIES } from "@/lib/rules";
import { GuildHeader } from "@/components/GuildHeader";
import { SubmitButton } from "@/components/SubmitButton";
import {
  addRuleAction,
  addStarterRulesAction,
  deleteRuleAction,
  moveRuleAction,
  toggleRuleAction,
  updateCommandConfigAction,
} from "./actions";

export const dynamic = "force-dynamic";

function Toggle({
  name,
  label,
  hint,
  checked,
}: {
  name: string;
  label: string;
  hint: string;
  checked: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 text-sm">
      <input type="checkbox" name={name} defaultChecked={checked} className="mt-0.5 h-4 w-4 cursor-pointer accent-accent" />
      <span>
        <span className="font-medium">{label}</span>
        <span className="block text-muted">{hint}</span>
      </span>
    </label>
  );
}

function RuleButton({ guildId, ruleId, action, extra, children, pendingText, variant = "secondary" }: {
  guildId: string;
  ruleId: string;
  action: (formData: FormData) => Promise<void>;
  extra?: Record<string, string>;
  children: React.ReactNode;
  pendingText: string;
  variant?: "secondary" | "danger";
}) {
  return (
    <form action={action}>
      <input type="hidden" name="guildId" value={guildId} />
      <input type="hidden" name="ruleId" value={ruleId} />
      {Object.entries(extra ?? {}).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <SubmitButton small variant={variant} pendingText={pendingText}>
        {children}
      </SubmitButton>
    </form>
  );
}

export default async function CommandsPage({
  params,
  searchParams,
}: {
  params: Promise<{ guildId: string }>;
  searchParams: Promise<{ success?: string; error?: string }>;
}) {
  const { guildId } = await params;
  const { success, error } = await searchParams;
  const db = getDb();

  try {
    await requireGuildAdmin(db, guildId);
  } catch (err) {
    if (err instanceof AuthError) redirect("/login");
    throw err;
  }

  const guild = await db.query.guilds.findFirst({ where: (g, { eq }) => eq(g.id, guildId) });
  if (!guild) notFound();

  const [report, status, rules] = await Promise.all([
    getCommandConfig(db, guildId, "report"),
    getCommandConfig(db, guildId, "status"),
    db.query.rules.findMany({
      where: (r, { and, eq }) => and(eq(r.guildId, guildId), eq(r.command, "report")),
      orderBy: (r, { asc }) => [asc(r.position), asc(r.id)],
    }),
  ]);

  const hiddenFields = (command: CommandName) => (
    <>
      <input type="hidden" name="guildId" value={guildId} />
      <input type="hidden" name="command" value={command} />
    </>
  );

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-4 py-10">
      <GuildHeader guildId={guildId} name={guild.name} active="commands" />

      {success && (
        <p role="status" className="alert-success">
          {success}
        </p>
      )}
      {error && (
        <p role="alert" className="alert-error">
          {error}
        </p>
      )}

      <section className="card flex flex-col gap-4">
        <div>
          <h2 className="font-semibold">
            <code className="font-mono">/report</code>
          </h2>
          <p className="text-sm text-muted">How this server&apos;s members file reports.</p>
        </div>
        <form action={updateCommandConfigAction} className="flex flex-col gap-4">
          {hiddenFields("report")}
          <Toggle name="enabled" label="Enabled" hint="When off, /report replies that it's turned off and records nothing." checked={report.enabled} />
          <Toggle name="ephemeral" label="Private confirmation" hint="Only the person who ran the command sees the reply. Turn off to confirm in the channel." checked={report.ephemeral} />
          <Toggle name="modalWhenEmpty" label="Open a form when run without text" hint="/report on its own pops up a title + details dialog." checked={report.modalWhenEmpty} />
          <Toggle name="postToChannel" label="Post to the report channel" hint="Send each report to the channel chosen in Settings." checked={report.postToChannel} />
          <Toggle name="mirror" label="Mirror to the second channel" hint="Send a copy to the Slack/Discord webhook chosen in Settings." checked={report.mirror} />
          <div className="flex flex-wrap items-end gap-3 text-sm">
            <label className="flex flex-col gap-1">
              <span className="font-medium">Rate limit: reports per person</span>
              <input type="number" name="cooldownCount" min={0} max={100} defaultValue={report.cooldownCount} className="input w-32" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-medium">within (seconds)</span>
              <input type="number" name="cooldownWindowSeconds" min={10} max={3600} defaultValue={report.cooldownWindowSeconds} className="input w-32" />
            </label>
            <span className="pb-2 text-muted">0 = no limit</span>
          </div>
          <div>
            <SubmitButton pendingText="Saving…">Save /report settings</SubmitButton>
          </div>
        </form>
      </section>

      <section className="card flex flex-col gap-4">
        <div>
          <h2 className="font-semibold">
            <code className="font-mono">/status</code>
          </h2>
          <p className="text-sm text-muted">The server summary command.</p>
        </div>
        <form action={updateCommandConfigAction} className="flex flex-col gap-4">
          {hiddenFields("status")}
          <Toggle name="enabled" label="Enabled" hint="When off, /status replies that it's turned off." checked={status.enabled} />
          <Toggle name="ephemeral" label="Private reply" hint="Only the person who ran the command sees the summary." checked={status.ephemeral} />
          <div>
            <SubmitButton pendingText="Saving…">Save /status settings</SubmitButton>
          </div>
        </form>
      </section>

      <section className="card flex flex-col gap-4">
        <div>
          <h2 className="font-semibold">Rules for /report</h2>
          <p className="text-sm text-muted">
            Applied in order to every new report; each rule that matches takes effect, so a later rule can override an
            earlier one&apos;s priority. The log shows which rules fired.
          </p>
        </div>

        {rules.length === 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-border p-4 text-sm">
            <span className="text-muted">No rules yet, so every report is filed at medium priority.</span>
            <form action={addStarterRulesAction}>
              <input type="hidden" name="guildId" value={guildId} />
              <SubmitButton variant="secondary" pendingText="Adding…">
                Add starter rules
              </SubmitButton>
            </form>
          </div>
        ) : (
          <ol className="flex flex-col gap-2">
            {rules.map((rule, index) => {
              const parsed = parseRule(rule);
              return (
                <li
                  key={rule.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
                >
                  <div className={`text-sm ${rule.enabled ? "" : "opacity-50"}`}>
                    {parsed ? (
                      <>
                        <p className="font-medium">{describeCondition(parsed.condition)}</p>
                        <p className="text-muted">→ {parsed.actions.map(describeAction).join(", ")}</p>
                      </>
                    ) : (
                      <p className="text-red-700 dark:text-red-300">Invalid rule (ignored). Delete it.</p>
                    )}
                    {!rule.enabled && <p className="text-xs text-muted">Turned off</p>}
                  </div>
                  <div className="flex gap-1.5">
                    {index > 0 && (
                      <RuleButton guildId={guildId} ruleId={rule.id} action={moveRuleAction} extra={{ direction: "up" }} pendingText="…">
                        ↑
                      </RuleButton>
                    )}
                    {index < rules.length - 1 && (
                      <RuleButton guildId={guildId} ruleId={rule.id} action={moveRuleAction} extra={{ direction: "down" }} pendingText="…">
                        ↓
                      </RuleButton>
                    )}
                    <RuleButton guildId={guildId} ruleId={rule.id} action={toggleRuleAction} pendingText="…">
                      {rule.enabled ? "Turn off" : "Turn on"}
                    </RuleButton>
                    <RuleButton guildId={guildId} ruleId={rule.id} action={deleteRuleAction} variant="danger" pendingText="Deleting…">
                      Delete
                    </RuleButton>
                  </div>
                </li>
              );
            })}
          </ol>
        )}

        {rules.length < MAX_RULES_PER_COMMAND && (
          <form action={addRuleAction} className="flex flex-col gap-3 border-t border-border pt-4 text-sm">
            <input type="hidden" name="guildId" value={guildId} />
            <p className="font-medium">Add a rule</p>
            <label className="flex flex-col gap-1">
              <span>If the report contains (comma-separated keywords, any match; leave empty for every report)</span>
              <input name="keywords" maxLength={100} placeholder="e.g. urgent, outage, security" className="input" />
            </label>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1">
                <span>Then</span>
                <select name="actionType" defaultValue="set_priority" className="input w-auto">
                  <option value="set_priority">set priority to…</option>
                  <option value="skip_mirror">don&apos;t mirror it</option>
                  <option value="reply_note">add a note to the reply…</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span>Priority</span>
                <select name="priority" defaultValue="high" className="input w-auto">
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex min-w-48 flex-1 flex-col gap-1">
                <span>Note (for &ldquo;add a note&rdquo;)</span>
                <input name="note" maxLength={200} placeholder="e.g. An admin will look within the hour." className="input" />
              </label>
            </div>
            <div>
              <SubmitButton pendingText="Adding…">Add rule</SubmitButton>
            </div>
          </form>
        )}
      </section>
    </main>
  );
}
