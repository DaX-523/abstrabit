import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/auth";

/**
 * UX-only redirect: sends an unauthenticated browser navigation to
 * /dashboard/* to /login instead of rendering a broken page. This is NOT the
 * authorization boundary -- it only checks that a session cookie is present,
 * not that it's valid or unexpired (that needs the DB, which proxy/edge
 * code shouldn't depend on). Every dashboard server component, action, and
 * API route calls requireUser()/requireGuildAdmin() itself; see CLAUDE.md.
 */
export function proxy(request: NextRequest) {
  const hasSessionCookie = request.cookies.has(SESSION_COOKIE_NAME);
  if (!hasSessionCookie) {
    const url = new URL("/login", request.url);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*"],
};
