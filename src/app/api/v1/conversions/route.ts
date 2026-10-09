import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { withSystem, withWorkspace, sql } from "@/server/db";
import { decryptSecret } from "@/server/auth/crypto";
import { conversionEventSchema, recordConversion } from "@/server/services/conversions";

/**
 * POST /api/v1/conversions — conversion events from the product (Orbit).
 * Auth: X-Outbound-Signature: sha256=<HMAC-SHA256(raw body, secret)>.
 * Workspace: ?workspace=<slug> (optional when there's only one workspace).
 * Body: one event, or { "events": [ ... ] } (max 500).
 */
export async function POST(req: Request) {
  const raw = await req.text();
  if (raw.length > 512_000) return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  const slug = new URL(req.url).searchParams.get("workspace") ?? req.headers.get("x-outbound-workspace");
  const ws = await withSystem(async (q) => {
    const rows = slug
      ? await q.many<{ id: string }>(sql`select id from workspaces where slug = ${slug}`)
      : await q.many<{ id: string }>(sql`select id from workspaces limit 2`);
    if (rows.length !== 1) return null;
    const secretRow = await q.maybe<{ secret_ciphertext: string | null }>(sql`select secret_ciphertext from integrations where workspace_id = ${rows[0].id} and key = 'conversions_webhook'`);
    return { id: rows[0].id, secret: secretRow?.secret_ciphertext ? decryptSecret(secretRow.secret_ciphertext) : process.env.CONVERSION_WEBHOOK_SECRET ?? null };
  });
  if (!ws) return NextResponse.json({ error: "Unknown workspace — pass ?workspace=<slug>" }, { status: 404 });
  if (!ws.secret) return NextResponse.json({ error: "Webhook secret not configured (Integrations → Orbit conversions)" }, { status: 503 });

  const sig = (req.headers.get("x-outbound-signature") ?? "").replace(/^sha256=/, "");
  const expected = createHmac("sha256", ws.secret).update(raw).digest("hex");
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = z.union([z.object({ events: z.array(conversionEventSchema).min(1).max(500) }), conversionEventSchema]).safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid event", issues: parsed.error.issues.slice(0, 5) }, { status: 422 });
  const events = "events" in parsed.data ? parsed.data.events : [parsed.data];

  const results = [];
  for (const e of events) {
    const r = await withWorkspace({ workspaceId: ws.id }, (q) => recordConversion(q, { workspaceId: ws.id, actorType: "webhook" }, e));
    results.push({ id: r.id, matched: r.matched, method: r.method, duplicate: r.duplicate });
  }
  await withWorkspace({ workspaceId: ws.id }, (q) => q.exec(sql`update integrations set last_success_at = now(), status = 'connected' where key = 'conversions_webhook'`));
  return NextResponse.json({ ok: true, results });
}
