import { sql, and, raw, type Q, type SqlFragment } from "../db";
import { differenceInCalendarDays, startOfDay } from "date-fns";

/**
 * All dashboard/analytics numbers are computed from the database here.
 * Nothing is hard-coded or estimated: if there's no data, the number is 0.
 */

export { FUNNEL_STAGES, type FunnelKey, type Funnel } from "../domain/funnel";
import { FUNNEL_STAGES, type FunnelKey, type Funnel } from "../domain/funnel";

export interface Scope {
  campaignId?: string | null;
  from?: Date | null;
  to?: Date | null;
  /** Extra predicate over `prospects p` (e.g. a compiled segment filter). */
  where?: SqlFragment;
  includeDemo?: boolean;
}

export function scopeWhere(s: Scope): SqlFragment {
  return and([
    sql`p.merged_into is null`,
    s.campaignId ? sql`exists (select 1 from campaign_prospects cp where cp.prospect_id = p.id and cp.campaign_id = ${s.campaignId})` : null,
    s.where ?? null,
  ]);
}

export async function funnel(q: Q, s: Scope = {}): Promise<Funnel> {
  const cols = FUNNEL_STAGES.map((st) => {
    const inRange = and([
      raw(st.where),
      s.from ? sql`${raw(st.column)} >= ${s.from}` : null,
      s.to ? sql`${raw(st.column)} < ${s.to}` : null,
    ]);
    return sql`count(*) filter (where ${inRange})::int as ${raw(st.key)}`;
  });
  let select = cols[0];
  for (const c of cols.slice(1)) select = sql`${select}, ${c}`;
  return q.one<Funnel>(sql`select ${select} from prospects p where ${scopeWhere(s)}`);
}

export interface GoalRow {
  id: string;
  name: string;
  metric: FunnelKey;
  target: number;
  start_date: string | Date;
  end_date: string | Date;
  campaign_id: string | null;
  geography: string | null;
}

export interface GoalProgress {
  completed: number;
  remaining: number;
  pct: number;
  daysTotal: number;
  daysElapsed: number;
  daysRemaining: number;
  currentPace: number;   // per day so far
  requiredPace: number;  // per day needed from today
  projected: number;     // at current pace, by end date
  status: "ahead" | "on_track" | "behind" | "not_started" | "completed" | "ended";
}

export async function goalProgress(q: Q, g: GoalRow, today = new Date()): Promise<GoalProgress> {
  const start = startOfDay(new Date(g.start_date));
  const end = startOfDay(new Date(g.end_date));
  const endExclusive = new Date(end.getTime() + 86_400_000);
  const geoWhere = g.geography ? sql`lower(p.city) = ${g.geography.toLowerCase()}` : undefined;
  const f = await funnel(q, { campaignId: g.campaign_id, from: start, to: endExclusive, where: geoWhere });
  const completed = f[g.metric] ?? 0;
  const daysTotal = differenceInCalendarDays(end, start) + 1;
  const daysElapsed = Math.min(daysTotal, Math.max(0, differenceInCalendarDays(startOfDay(today), start) + 1));
  const daysRemaining = Math.max(0, daysTotal - daysElapsed);
  const remaining = Math.max(0, g.target - completed);
  const currentPace = daysElapsed > 0 ? completed / daysElapsed : 0;
  const requiredPace = daysRemaining > 0 ? remaining / daysRemaining : remaining;
  const projected = Math.round(completed + currentPace * daysRemaining);
  let status: GoalProgress["status"];
  if (completed >= g.target) status = "completed";
  else if (daysElapsed === 0) status = "not_started";
  else if (daysRemaining === 0) status = "ended";
  else {
    const expectedByNow = (g.target * daysElapsed) / daysTotal;
    status = completed >= expectedByNow * 1.05 ? "ahead" : completed >= expectedByNow * 0.9 ? "on_track" : "behind";
  }
  return {
    completed, remaining, pct: g.target ? Math.min(100, (completed / g.target) * 100) : 0, daysTotal, daysElapsed, daysRemaining,
    currentPace, requiredPace, projected, status,
  };
}

/** Rate helper that returns null (rendered "—") rather than a misleading 0%. */
export function safeRate(n: number, d: number): number | null {
  return d > 0 ? n / d : null;
}

export interface DailyBrief {
  highFitReady: number;
  followupsDue: number;
  repliesNeedingResponse: number;
  hotProspects: number;
  needsReview: number;
  yesterday: { contacted: number; replies: number; signups: number };
  bestSegment: { label: string; signupRate: number; contacted: number } | null;
}

export async function dailyBrief(q: Q): Promise<DailyBrief> {
  const today = startOfDay(new Date());
  const yesterday = new Date(today.getTime() - 86_400_000);
  const row = await q.one<Omit<DailyBrief, "yesterday" | "bestSegment"> & { y_contacted: number; y_replies: number; y_signups: number }>(sql`
    select
      (select count(*)::int from prospects p where p.merged_into is null and p.status in ('QUALIFIED','READY') and p.priority_score >= 70
         and not p.do_not_contact and p.first_contacted_at is null) as "highFitReady",
      (select count(*)::int from followups where status = 'pending' and due_at < ${new Date(today.getTime() + 86_400_000)}) as "followupsDue",
      (select count(*)::int from conversations where status = 'needs_response') as "repliesNeedingResponse",
      (select count(*)::int from prospects p where p.status in ('INTERESTED','DEMO') and not p.signed_up) as "hotProspects",
      (select count(*)::int from outreach_messages where status = 'needs_review') as "needsReview",
      (select count(*)::int from prospects p where p.first_contacted_at >= ${yesterday} and p.first_contacted_at < ${today}) as y_contacted,
      (select count(*)::int from conversation_messages m where m.direction = 'inbound' and m.occurred_at >= ${yesterday} and m.occurred_at < ${today}) as y_replies,
      (select count(*)::int from prospects p where p.signup_at >= ${yesterday} and p.signup_at < ${today}) as y_signups`);
  // Best segment = category × city with the highest signup rate among those
  // with a meaningful sample (≥ 20 contacted). No sample → no recommendation.
  const best = await q.maybe<{ category: string; city: string; contacted: number; signups: number }>(sql`
    select p.category, p.city, count(*)::int as contacted, count(*) filter (where p.signed_up)::int as signups
    from prospects p
    where p.first_contacted_at is not null and p.category is not null and p.city is not null and p.merged_into is null
    group by p.category, p.city
    having count(*) >= 20
    order by (count(*) filter (where p.signed_up))::float / count(*) desc, count(*) desc
    limit 1`);
  return {
    highFitReady: row.highFitReady, followupsDue: row.followupsDue, repliesNeedingResponse: row.repliesNeedingResponse,
    hotProspects: row.hotProspects, needsReview: row.needsReview,
    yesterday: { contacted: row.y_contacted, replies: row.y_replies, signups: row.y_signups },
    bestSegment: best && best.signups > 0 ? { label: `${best.city} · ${best.category}`, signupRate: best.signups / best.contacted, contacted: best.contacted } : null,
  };
}
