import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/auth";
import { buildDiscordAuthorizeUrl } from "@/lib/discord/oauth";

export const runtime = "nodejs";

export const OAUTH_STATE_COOKIE = "oauth_state";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const db = getDb();
  const user = await getCurrentUser(db);
  if (!user) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  const state = randomBytes(16).toString("hex");
  const res = NextResponse.redirect(buildDiscordAuthorizeUrl(state));
  res.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 5 * 60,
  });
  return res;
}
