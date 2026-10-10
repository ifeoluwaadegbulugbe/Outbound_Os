import { NextResponse, after } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { drain, scheduleRecurring } from "@/server/jobs/worker";
import { dispatchAllWorkspaces } from "@/server/email/send";

/**
 * Serverless job tick, called every minute by a scheduler (cron-job.org,
 * Vercel Cron…). Auth: Authorization: Bearer <CRON_SECRET>.
 *
 * Responds immediately (schedulers time out at ~30 s) and does the work after
 * the response: schedule recurring jobs, send queued emails within each
 * mailbox's limits, then run queued jobs for the rest of the time budget.
 */
export const maxDuration = 60;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not set" }, { status: 503 });
  const got = Buffer.from((req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(secret);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const started = Date.now();
  after(async () => {
    try {
      await scheduleRecurring();
      const sent = await dispatchAllWorkspaces();
      // Leave headroom under maxDuration (60 s).
      const processed = await drain({ timeBudgetMs: Math.max(5_000, 50_000 - (Date.now() - started)) });
      console.log(`[cron] tick done in ${Date.now() - started} ms · emails sent ${sent} · jobs processed ${processed}`);
    } catch (e) {
      console.error("[cron] tick failed", e);
    }
  });
  return NextResponse.json({ ok: true, accepted: true });
}
