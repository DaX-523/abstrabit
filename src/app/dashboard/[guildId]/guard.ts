import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { requireGuildAdmin, AuthError } from "@/lib/auth";

/**
 * Shared by every dashboard server action: reads the guild id from the form,
 * then checks -- server-side, against the DB -- that the signed-in user is an
 * admin of that guild. Throws AuthError otherwise. (Never rely on the proxy
 * alone for this; see CLAUDE.md.)
 */
export async function guardedGuildId(formData: FormData): Promise<string> {
  const guildId = String(formData.get("guildId") ?? "");
  if (!guildId) throw new AuthError("Missing guild id");
  await requireGuildAdmin(getDb(), guildId);
  return guildId;
}

/**
 * Redirects back to a dashboard page with a one-line success/error banner.
 * redirect() works by throwing, so never call this inside a try block whose
 * catch would swallow it (see the regression test in settingsActions.test.ts).
 */
export function redirectWithMessage(path: string, key: "success" | "error", message: string): never {
  redirect(`${path}?${key}=${encodeURIComponent(message)}`);
}
