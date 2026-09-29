import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireGuildAdmin, AuthError } from "@/lib/auth";
import { getRecentInteractions } from "@/lib/feed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ guildId: string }> },
): Promise<NextResponse> {
  const { guildId } = await params;
  const db = getDb();

  try {
    await requireGuildAdmin(db, guildId);
  } catch (err) {
    if (err instanceof AuthError) return new NextResponse("forbidden", { status: 403 });
    throw err;
  }

  const afterParam = req.nextUrl.searchParams.get("after");
  const after = afterParam ? new Date(afterParam) : undefined;
  if (after && Number.isNaN(after.getTime())) {
    return new NextResponse("invalid `after` timestamp", { status: 400 });
  }

  const items = await getRecentInteractions(db, guildId, { after });
  return NextResponse.json({ items });
}
