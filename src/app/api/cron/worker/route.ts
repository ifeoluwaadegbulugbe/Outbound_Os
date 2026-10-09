import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { drain, scheduleRecurring } from "@/server/jobs/worker";
import { dispatchAllWorkspaces } from "@/server/email/send";

/**
 * Serverless job tick (e.g. Vercel Cron every minute, or any external
 * scheduler): schedules recurring jobs and drains the queue for ~50s.
 * Auth: Authorization: Bearer <CRON_SECRET>.
 */
export const maxDuration = 60;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not set" }, { status: 503 });
  const got = Buffer.from((req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(secret);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await scheduleRecurring();
  const sent = await dispatchAllWorkspaces();
  const processed = await drain({ timeBudgetMs: 50_000 });
  return NextResponse.json({ ok: true, processed, sent });
}
