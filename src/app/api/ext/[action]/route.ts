import { NextResponse } from "next/server";
import { z } from "zod";
import { extensionUser } from "@/server/auth/extension";
import { withWorkspace, sql } from "@/server/db";
import { markSent, rejectMessages, senderUsage } from "@/server/services/outreach";
import { openUrl } from "@/server/domain/channels";
import type { Channel } from "@/server/domain/taxonomy";

/**
 * API for the companion browser extension.
 *   GET  /api/ext/session          → who am I, queue size
 *   GET  /api/ext/next?channel=…   → next approved message to send
 *   POST /api/ext/sent  {id}       → mark sent (enforces daily caps)
 *   POST /api/ext/skip  {id}       → skip
 * The extension only fills the message box; the human presses Send.
 */
async function ctx(req: Request) {
  const u = await extensionUser(req);
  if (!u) return null;
  return { u, run: <T,>(fn: Parameters<typeof withWorkspace<T>>[1]) => withWorkspace({ workspaceId: u.workspaceId, userId: u.userId }, fn) };
}

const NEXT_SQL = (channel: string | null) => sql`
  select m.id, m.channel, m.body, m.subject, p.id as prospect_id, p.business_name, p.instagram_handle, p.tiktok_handle, p.whatsapp, p.phone, p.email, p.is_demo
  from outreach_messages m join prospects p on p.id = m.prospect_id
  where (m.status = 'approved' or (m.status = 'scheduled' and m.scheduled_for <= now()))
    and not p.do_not_contact ${channel ? sql`and m.channel = ${channel}` : sql`and m.channel in ('instagram','tiktok','whatsapp')`}
  order by m.kind = 'followup' desc, p.priority_score desc nulls last, m.approved_at limit 1`;

export async function GET(req: Request, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  const c = await ctx(req);
  if (!c) return NextResponse.json({ error: "Invalid or missing extension token" }, { status: 401 });
  if (action === "session") {
    const r = await c.run(async (q) => ({
      queue: await q.value<number>(sql`select count(*)::int from outreach_messages where status = 'approved' and channel in ('instagram','tiktok','whatsapp')`),
      paused: await q.value<boolean>(sql`select outreach_paused from workspaces where id = ${c.u.workspaceId}`),
      usage: await senderUsage(q),
    }));
    return NextResponse.json({ user: { name: c.u.name }, ...r });
  }
  if (action === "next") {
    const channel = new URL(req.url).searchParams.get("channel");
    const ch = channel && ["instagram", "tiktok", "whatsapp"].includes(channel) ? channel : null;
    const r = await c.run(async (q) => {
      if (await q.value<boolean>(sql`select outreach_paused from workspaces where id = ${c.u.workspaceId}`)) return { paused: true as const };
      const m = await q.maybe<{ id: string; channel: Channel; body: string; subject: string | null; prospect_id: string; business_name: string; instagram_handle: string | null; tiktok_handle: string | null; whatsapp: string | null; phone: string | null; email: string | null; is_demo: boolean }>(NEXT_SQL(ch));
      if (!m) return { message: null };
      const usage = (await senderUsage(q)).filter((u) => u.channel === m.channel);
      return {
        message: {
          id: m.id, channel: m.channel, text: m.body, businessName: m.business_name, handle: m.instagram_handle ?? m.tiktok_handle,
          // Demo prospects are fictional: never open a real profile for them.
          url: m.is_demo ? null : openUrl(m.channel, m, m.body, m.subject), isDemo: m.is_demo,
        },
        usage,
      };
    });
    return NextResponse.json(r, { headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function POST(req: Request, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  const c = await ctx(req);
  if (!c) return NextResponse.json({ error: "Invalid or missing extension token" }, { status: 401 });
  const body = z.object({ id: z.string().uuid() }).safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "Missing message id" }, { status: 400 });
  const actor = { workspaceId: c.u.workspaceId, actorType: "user" as const, actorId: c.u.userId };
  if (action === "sent") {
    const r = await c.run((q) => markSent(q, actor, body.data.id));
    return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ ok: false, error: r.error }, { status: 409 });
  }
  if (action === "skip") {
    await c.run((q) => rejectMessages(q, actor, [body.data.id], "skipped"));
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}
