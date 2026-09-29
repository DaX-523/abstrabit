import "server-only";
import { RetryableError, PermanentError } from "@/lib/jobs/runner";

/**
 * Sends a notification to the second channel (Slack Incoming Webhook or a
 * separate Discord channel webhook), auto-detected from the URL's host.
 *
 * SSRF guard: only these two hosts are ever fetched. An admin-supplied
 * mirror URL that points anywhere else (an internal IP, a redirect chain,
 * whatever) is rejected before any request is made.
 */

export type MirrorKind = "slack" | "discord";

export function detectMirrorKind(url: string): MirrorKind | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.host === "hooks.slack.com") return "slack";
  if (
    (parsed.host === "discord.com" || parsed.host === "discordapp.com") &&
    parsed.pathname.startsWith("/api/webhooks/")
  ) {
    return "discord";
  }
  return null;
}

export interface MirrorMessage {
  title: string;
  lines: string[];
}

export async function sendMirror(url: string, message: MirrorMessage): Promise<void> {
  const kind = detectMirrorKind(url);
  if (!kind) {
    throw new PermanentError("mirror url is not an allowed Slack or Discord webhook host");
  }

  const body =
    kind === "slack"
      ? { text: `*${message.title}*\n${message.lines.join("\n")}` }
      : {
          content: `**${message.title}**\n${message.lines.join("\n")}`,
          allowed_mentions: { parse: [] },
        };

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new RetryableError(`network error posting to mirror webhook: ${String(err)}`);
  }

  if (res.status === 429) {
    const header = res.headers.get("retry-after");
    const retryAfterMs = header ? Math.ceil(parseFloat(header) * 1000) : 2000;
    throw new RetryableError("mirror webhook rate limited", { retryAfterMs, httpStatus: 429 });
  }
  if (res.status >= 500) {
    throw new RetryableError(`mirror webhook returned ${res.status}`, { httpStatus: res.status });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new PermanentError(`mirror webhook returned ${res.status}: ${text.slice(0, 200)}`, {
      httpStatus: res.status,
    });
  }
}
