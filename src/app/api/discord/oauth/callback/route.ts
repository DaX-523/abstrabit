import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/db";
import { getCurrentUser } from "@/lib/auth";
import { exchangeOAuthCode } from "@/lib/discord/oauth";
import { log } from "@/lib/log";
import { seedGuildDefaults } from "@/lib/guildSetup";
import { OAUTH_STATE_COOKIE } from "../start/route";

export const runtime = "nodejs";

function redirectToDashboard(req: NextRequest, error?: string): NextResponse {
  const url = new URL("/dashboard", req.url);
  if (error) url.searchParams.set("error", error);
  const res = NextResponse.redirect(url);
  res.cookies.delete(OAUTH_STATE_COOKIE);
  return res;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const db = getDb();
  const user = await getCurrentUser(db);
  if (!user) return NextResponse.redirect(new URL("/login", req.url));

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = req.cookies.get(OAUTH_STATE_COOKIE)?.value;

  // CSRF guard on the OAuth callback: the state must match what we set on
  // our own domain right before redirecting to Discord.
  if (!code || !state || !cookieState || state !== cookieState) {
    log.warn("rejected OAuth callback: state mismatch or missing code");
    return redirectToDashboard(req, "Connection failed (invalid state). Please try again.");
  }

  let exchange;
  try {
    exchange = await exchangeOAuthCode(code);
  } catch (err) {
    log.error("OAuth code exchange failed", { error: err instanceof Error ? err.message : String(err) });
    return redirectToDashboard(req, "Connection failed while talking to Discord. Please try again.");
  }

  // The guild the bot was added to comes only from this server-to-server
  // response, never from a client-controlled query parameter.
  const guild = exchange.guild;
  if (!guild) {
    return redirectToDashboard(req, "Discord didn't report which server the bot was added to.");
  }

  await db.transaction(async (tx) => {
    await tx
      .insert(schema.guilds)
      .values({ id: guild.id, name: guild.name })
      .onConflictDoUpdate({
        target: schema.guilds.id,
        set: { name: guild.name, updatedAt: new Date() },
      });
    await tx
      .insert(schema.guildAdmins)
      .values({ guildId: guild.id, userId: user.id })
      .onConflictDoNothing({ target: [schema.guildAdmins.guildId, schema.guildAdmins.userId] });
    await seedGuildDefaults(tx, guild.id);
  });

  log.info("guild connected", { guildId: guild.id, userId: user.id });

  const res = NextResponse.redirect(new URL(`/dashboard/${guild.id}/settings`, req.url));
  res.cookies.delete(OAUTH_STATE_COOKIE);
  return res;
}
