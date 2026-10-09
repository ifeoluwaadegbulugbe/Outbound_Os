import { sql, json, type Q } from "../db";
import {
  scoreIcp, scoreCompleteness, scorePriority, DEFAULT_ICP, SCORER_VERSION,
  type IcpConfig, type ScorableProspect,
} from "../domain/scoring";
import { CATEGORY_VALUE_PROPS } from "../domain/taxonomy";

export async function getIcpConfig(q: Q, icpProfileId?: string | null): Promise<{ id: string | null; config: IcpConfig }> {
  const row = icpProfileId
    ? await q.maybe<{ id: string; config: Partial<IcpConfig> }>(sql`select id, config from icp_profiles where id = ${icpProfileId}`)
    : await q.maybe<{ id: string; config: Partial<IcpConfig> }>(sql`select id, config from icp_profiles where is_default order by created_at limit 1`);
  return { id: row?.id ?? null, config: { ...DEFAULT_ICP, ...(row?.config ?? {}) } };
}

const SCORABLE_COLUMNS = sql`
  business_name, category, services, country, city, business_size, instagram_handle, tiktok_handle, facebook_url,
  linkedin_url, email, phone, whatsapp, website, booking_url, bio, description, follower_count, last_post_date,
  posting_frequency, accepts_bookings, has_booking_link, accepts_whatsapp_bookings, accepts_online_payments,
  has_website, has_client_management_system, has_invoice_system, has_payment_system, signals, status`;

/** Recompute and persist all scores for one prospect. Returns the new ICP score. */
export async function rescoreProspect(q: Q, prospectId: string, icp?: { id: string | null; config: IcpConfig }): Promise<number> {
  const cfg = icp ?? (await getIcpConfig(q));
  const p = await q.maybe<ScorableProspect & { status: string }>(sql`select ${SCORABLE_COLUMNS} from prospects where id = ${prospectId}`);
  if (!p) return 0;
  const r = scoreIcp(p, cfg.config);
  const c = scoreCompleteness(p);
  const pr = scorePriority(p, r, c);
  const angle = recommendAngle(p);
  const breakdown = { reasons: r.reasons, components: r.components, completeness: c, priority: pr.parts };
  // Status: NEW <-> QUALIFIED is driven by the score; later stages are never touched here.
  const newStatus = p.status === "NEW" && r.qualified ? "QUALIFIED" : p.status === "QUALIFIED" && !r.qualified ? "NEW" : p.status;
  await q.exec(sql`
    update prospects set
      icp_score = ${r.icp}, fit_score = ${r.fit}, intent_score = ${r.intent}, priority_score = ${pr.score},
      completeness_score = ${c.score}, outreach_priority = ${pr.tier}, score_reasons = ${json(breakdown)},
      recommended_message_angle = ${angle}, scored_at = now(), status = ${newStatus},
      qualified_at = case when ${r.qualified} then coalesce(qualified_at, now()) else qualified_at end
    where id = ${prospectId}`);
  await q.exec(sql`
    insert into prospect_scores (workspace_id, prospect_id, icp_profile_id, icp_score, fit_score, intent_score, priority_score, completeness_score, breakdown, scorer_version)
    select workspace_id, id, ${cfg.id}, ${r.icp}, ${r.fit}, ${r.intent}, ${pr.score}, ${c.score}, ${json(breakdown)}, ${SCORER_VERSION}
    from prospects where id = ${prospectId}`);
  return r.icp;
}

/** Best opening angle given the evidence we hold. */
export function recommendAngle(p: ScorableProspect): string {
  const s = (k: string) => p.signals?.[k]?.value === true;
  if (s("dmBookings") || s("whatsappBookings") || p.accepts_whatsapp_bookings) return "problem_first";
  if (s("manualPayments")) return "problem_first";
  if (p.booking_url || p.signals?.schedulingTool) return "feedback_request";
  if (p.accepts_bookings || s("acceptsBookings")) return "outcome";
  return "curiosity";
}

export function valuePropsFor(category: string | null): string[] {
  return CATEGORY_VALUE_PROPS[category ?? "other_service"] ?? CATEGORY_VALUE_PROPS.other_service;
}
