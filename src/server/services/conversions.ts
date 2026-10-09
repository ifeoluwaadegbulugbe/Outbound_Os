import { z } from "zod";
import { sql, raw, json, type Q } from "../db";
import { normalizeEmail, normalizeHandle, normalizePhone } from "../domain/normalize";
import { canTransition } from "../domain/status";
import type { ProspectStatus } from "../domain/taxonomy";
import { cancelFollowups } from "./outreach";
import { audit, logEvent, notify, type ActorCtx } from "./audit";

/**
 * Conversion events from the product (Orbit): signup → activated → paid.
 * Matching order: tracked-link ref code → email → phone → Instagram handle.
 * Unmatched events are kept so they can be matched manually later.
 */

export const conversionEventSchema = z.object({
  type: z.enum(["visit", "signup", "activated", "paid"]),
  external_user_id: z.string().max(200).optional().nullable(),
  email: z.string().max(320).optional().nullable(),
  phone: z.string().max(40).optional().nullable(),
  instagram: z.string().max(60).optional().nullable(),
  ref_code: z.string().max(40).optional().nullable(),
  utm: z.record(z.string(), z.string().max(200)).optional().nullable(),
  plan: z.string().max(100).optional().nullable(),
  amount: z.number().optional().nullable(),
  currency: z.string().max(10).optional().nullable(),
  occurred_at: z.string().datetime({ offset: true }).optional().nullable(),
});
export type ConversionEvent = z.infer<typeof conversionEventSchema>;

interface Match {
  prospectId: string;
  method: "ref_code" | "email" | "phone" | "instagram" | "manual";
  campaignId: string | null;
  variantId: string | null;
  channel: string | null;
}

async function match(q: Q, e: ConversionEvent): Promise<Match | null> {
  if (e.ref_code) {
    const l = await q.maybe<{ prospect_id: string | null; campaign_id: string | null; variant_id: string | null; channel: string | null }>(
      sql`select prospect_id, campaign_id, variant_id, channel from tracked_links where code = ${e.ref_code}`);
    if (l?.prospect_id) return { prospectId: l.prospect_id, method: "ref_code", campaignId: l.campaign_id, variantId: l.variant_id, channel: l.channel };
  }
  const email = normalizeEmail(e.email);
  if (email) {
    const p = await q.maybe<{ id: string }>(sql`select id from prospects where lower(email) = ${email} and merged_into is null limit 1`);
    if (p) return { prospectId: p.id, method: "email", campaignId: null, variantId: null, channel: null };
  }
  const phone = normalizePhone(e.phone);
  if (phone) {
    const p = await q.maybe<{ id: string }>(sql`select id from prospects where (phone = ${phone} or whatsapp = ${phone}) and merged_into is null limit 1`);
    if (p) return { prospectId: p.id, method: "phone", campaignId: null, variantId: null, channel: null };
  }
  const ig = normalizeHandle(e.instagram);
  if (ig) {
    const p = await q.maybe<{ id: string }>(sql`select id from prospects where lower(instagram_handle) = ${ig} and merged_into is null limit 1`);
    if (p) return { prospectId: p.id, method: "instagram", campaignId: null, variantId: null, channel: null };
  }
  return null;
}

/** Attribution context = the last sent outreach message before the conversion. */
async function attributionFor(q: Q, prospectId: string, m: Match, at: Date) {
  const last = await q.maybe<{ campaign_id: string | null; variant_id: string | null; channel: string; angle: string | null; id: string }>(sql`
    select id, campaign_id, variant_id, channel, angle from outreach_messages where prospect_id = ${prospectId} and status = 'sent' and sent_at <= ${at}
    order by sent_at desc limit 1`);
  const p = await q.one<{ source: string; icp_score: number | null; business_name: string }>(sql`select source, icp_score, business_name from prospects where id = ${prospectId}`);
  return {
    campaign_id: m.campaignId ?? last?.campaign_id ?? null,
    variant_id: m.variantId ?? last?.variant_id ?? null,
    channel: m.channel ?? last?.channel ?? null,
    angle: last?.angle ?? null,
    last_message_id: last?.id ?? null,
    prospect_source: p.source,
    icp_score: p.icp_score,
    match_method: m.method,
    business_name: p.business_name,
  };
}

const FIELDS: Record<"signup" | "activated" | "paid", { flag: string; at: string; status: ProspectStatus }> = {
  signup: { flag: "signed_up", at: "signup_at", status: "SIGNED_UP" },
  activated: { flag: "activated", at: "activation_at", status: "ACTIVATED" },
  paid: { flag: "paid", at: "paid_at", status: "PAID" },
};

export async function recordConversion(q: Q, actor: ActorCtx, e: ConversionEvent, manualProspectId?: string): Promise<{ id: string; matched: boolean; prospectId: string | null; method: string; duplicate: boolean }> {
  const at = e.occurred_at ? new Date(e.occurred_at) : new Date();
  const m: Match | null = manualProspectId
    ? { prospectId: manualProspectId, method: "manual", campaignId: null, variantId: null, channel: null }
    : await match(q, e);

  // Idempotency: same external user + type is recorded once.
  if (e.external_user_id) {
    const existing = await q.maybe<{ id: string; prospect_id: string | null; match_method: string }>(
      sql`select id, prospect_id, match_method from conversions where type = ${e.type} and external_user_id = ${e.external_user_id}`);
    if (existing && (existing.prospect_id || !m)) return { id: existing.id, matched: Boolean(existing.prospect_id), prospectId: existing.prospect_id, method: existing.match_method, duplicate: true };
    if (existing && m) await q.exec(sql`delete from conversions where id = ${existing.id}`);
  }

  const attr = m ? await attributionFor(q, m.prospectId, m, at) : null;
  const id = await q.value<string>(sql`
    insert into conversions (workspace_id, prospect_id, type, external_user_id, email, phone, ref_code, utm, plan, amount, currency, occurred_at,
                             match_method, campaign_id, variant_id, channel, source, raw)
    values (${actor.workspaceId}, ${m?.prospectId ?? null}, ${e.type}, ${e.external_user_id ?? null}, ${normalizeEmail(e.email)}, ${normalizePhone(e.phone)},
            ${e.ref_code ?? null}, ${json(e.utm ?? {})}, ${e.plan ?? null}, ${e.amount ?? null}, ${e.currency ?? null}, ${at},
            ${m?.method ?? "unmatched"}, ${attr?.campaign_id ?? null}, ${attr?.variant_id ?? null}, ${attr?.channel ?? null},
            ${actor.actorType === "webhook" ? "webhook" : manualProspectId ? "manual" : "csv"}, ${json(e)})
    returning id`);

  if (!m || e.type === "visit") {
    if (m && e.type === "visit") await q.exec(sql`update prospects set visited_product = true where id = ${m.prospectId}`);
    return { id, matched: Boolean(m), prospectId: m?.prospectId ?? null, method: m?.method ?? "unmatched", duplicate: false };
  }

  // Apply to the prospect: a later stage implies the earlier ones.
  const p = await q.one<{ status: ProspectStatus; signed_up: boolean; business_name: string }>(sql`select status, signed_up, business_name from prospects where id = ${m.prospectId}`);
  const stages = e.type === "paid" ? ["signup", "activated", "paid"] : e.type === "activated" ? ["signup", "activated"] : ["signup"];
  for (const st of stages as ("signup" | "activated" | "paid")[]) {
    const f = FIELDS[st];
    await q.exec(sql`update prospects set ${raw(f.flag)} = true, ${raw(f.at)} = coalesce(${raw(f.at)}, ${at}) where id = ${m.prospectId}`);
  }
  const target = FIELDS[e.type].status;
  if (canTransition(p.status, target).ok) await q.exec(sql`update prospects set status = ${target} where id = ${m.prospectId}`);
  await q.exec(sql`update prospects set subscription_plan = coalesce(${e.plan ?? null}, subscription_plan),
                   attribution = coalesce(attribution, ${json(attr)}) where id = ${m.prospectId}`);
  await cancelFollowups(q, m.prospectId, `converted:${e.type}`);
  await q.exec(sql`update conversations set status = 'closed' where prospect_id = ${m.prospectId} and status <> 'closed' and ${e.type === "paid"}`);
  await logEvent(q, actor, { type: `conversion.${e.type}`, prospectId: m.prospectId, campaignId: attr?.campaign_id, channel: attr?.channel, data: { match: m.method, plan: e.plan ?? undefined }, at });

  const campaignName = attr?.campaign_id ? await q.value<string | null>(sql`select name from campaigns where id = ${attr.campaign_id}`) : null;
  const titles = {
    signup: `🎉 ${campaignName ? `A prospect from your ${campaignName} campaign` : p.business_name} just signed up for Orbit`,
    activated: `${p.business_name} activated their Orbit account`,
    paid: `💰 ${p.business_name} became a paying customer`,
  };
  await notify(q, actor.workspaceId, { type: e.type, title: titles[e.type], body: `${p.business_name} · matched by ${m.method.replace("_", " ")}`, link: `/prospects/${m.prospectId}` });
  await audit(q, actor, `conversion.${e.type}`, "prospect", m.prospectId, { method: m.method });
  return { id, matched: true, prospectId: m.prospectId, method: m.method, duplicate: false };
}
