import { NextResponse } from "next/server";
import { withSystem, sql } from "@/server/db";

/** Liveness/readiness probe for hosting platforms. No sensitive data. */
export async function GET() {
  try {
    await withSystem((q) => q.value(sql`select 1`));
    return NextResponse.json({ ok: true, database: "up" });
  } catch {
    return NextResponse.json({ ok: false, database: "down" }, { status: 503 });
  }
}
