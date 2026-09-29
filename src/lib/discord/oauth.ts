import "server-only";
import { getEnv } from "@/lib/env";
import { PERMISSION } from "./permissions";

/** What the bot asks for when an admin adds it to a server: view + post +
 * embed + read history in the channels it's given access to. */
const REQUIRED_BOT_PERMISSIONS =
  PERMISSION.VIEW_CHANNEL | PERMISSION.SEND_MESSAGES | PERMISSION.EMBED_LINKS | PERMISSION.READ_MESSAGE_HISTORY;

export function buildDiscordAuthorizeUrl(state: string): string {
  const env = getEnv();
  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", env.DISCORD_APPLICATION_ID);
  url.searchParams.set("scope", "bot applications.commands");
  url.searchParams.set("permissions", REQUIRED_BOT_PERMISSIONS.toString());
  url.searchParams.set("redirect_uri", env.DISCORD_OAUTH_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  return url.toString();
}

export interface OAuthExchangeResult {
  guild?: { id: string; name: string };
}

/**
 * Exchanges the authorization code for a token. With the `bot` scope,
 * Discord adds the bot to the guild the admin picked at consent time and
 * echoes that guild back in this response -- we never trust a guild id
 * from a query string, only from this server-to-server call.
 */
export async function exchangeOAuthCode(code: string): Promise<OAuthExchangeResult> {
  const env = getEnv();
  const body = new URLSearchParams({
    client_id: env.DISCORD_APPLICATION_ID,
    client_secret: env.DISCORD_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: env.DISCORD_OAUTH_REDIRECT_URI,
  });

  const res = await fetch("https://discord.com/api/v10/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord OAuth token exchange failed: ${res.status} ${text.slice(0, 300)}`);
  }

  return res.json();
}
