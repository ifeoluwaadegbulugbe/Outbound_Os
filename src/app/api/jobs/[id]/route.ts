import { NextResponse } from "next/server";
import { getUser, asUser } from "@/server/auth/session";
import { sql } from "@/server/db";

/** Job status for progress bars (polled by the client). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const job = await asUser(user, (q) => q.maybe(sql`
    select id, type, status, progress_current, progress_total, progress_label, attempts, max_attempts, last_error, result, created_at, started_at, finished_at
    from jobs where id = ${id}`));
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(job, { headers: { "Cache-Control": "no-store" } });
}
