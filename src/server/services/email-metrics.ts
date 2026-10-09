import { sql, and, raw, type Q, type SqlFragment } from "../db";
import { effectiveDailyCap } from "../domain/channels";
import type { DnsCheck } from "../email/dns-check";

/**
 * Email funnel and deliverability numbers, computed from real rows only
 * (prospects, outreach_messages, email_events, conversations, conversions,
 * costs). Test sends (is_test) and demo prospects are always excluded.
 * "Delivered" means the provider accepted the message and no bounce arrived
 * within 48 hours. Mailbox APIs don't return delivery receipts, so this is
 * labelled as presumed in the UI.
 */

export interface EmailScope {
  campaignId?: string | null;
  from?: Date | null;
  to?: Date | null;
  country?: string | null;
}

export const EMAIL_FUNNEL = [
  { key: "discovered", label: "Discovered" },
  { key: "email_found", label: "Email found" },
  { key: "verified", label: "Verified" },
  { key: "qualified", label: "Qualified" },
  { key: "drafted", label: "Draft created" },
  { key: "sent", label: "Sent" },
  { key: "delivered", label: "Delivered (no bounce)" },
  { key: "replied", label: "Replied" },
  { key: "interested", label: "Interested" },
  { key: "signed_up", label: "Signed up" },
  { key: "activated", label: "Activated" },
  { key: "paid", label: "Paid" },
] as const;
export type EmailFunnelKey = (typeof EMAIL_FUNNEL)[number]["key"];
export type EmailFunnel = Record<EmailFunnelKey, number>;

const POSITIVE = ["interested", "pricing", "question", "demo_request", "signup_intent"];

function prospectScope(s: EmailScope): SqlFragment {
  return and([
    sql`p.merged_into is null and not p.is_demo`,
    s.campaignId ? sql`exists (select 1 from campaign_prospects cp where cp.prospect_id = p.id and cp.campaign_id = ${s.campaignId})` : null,
    s.country ? sql`p.country = ${s.country}` : null,
  ]);
}

function sentScope(s: EmailScope, alias = "m"): SqlFragment {
  const a = (c: string) => sql`${raw(alias)}.${raw(c)}`;
  return and([
    sql`${a("channel")} = 'email' and ${a("status")} = 'sent' and not ${a("is_test")}`,
    s.campaignId ? sql`${a("campaign_id")} = ${s.campaignId}` : null,
    s.from ? sql`${a("sent_at")} >= ${s.from}` : null,
    s.to ? sql`${a("sent_at")} < ${s.to}` : null,
  ]);
}
export async function emailFunnel(q: Q, s: EmailScope = {}): Promise<EmailFunnel> {
  return q.one<EmailFunnel>(sql`
    with sent as (
      select m.prospect_id, bool_or(m.delivery_status = 'delivered') as delivered
      from outreach_messages m where ${sentScope(s)} group by m.prospect_id
    ), replied as (
      select distinct e.prospect_id from email_events e join outreach_messages m on m.id = e.message_id
      where e.type = 'replied' and coalesce(e.detail, '') not like 'Auto-reply%' and ${sentScope(s)}
    ), drafted as (
      select distinct m.prospect_id from outreach_messages m
      where m.channel = 'email' and m.kind = 'initial' and m.status not in ('rejected') and not m.is_test
        ${s.campaignId ? sql`and m.campaign_id = ${s.campaignId}` : sql``}
    )
    select
      count(*)::int as discovered,
      count(*) filter (where p.email is not null)::int as email_found,
      count(*) filter (where p.email_status = 'verified')::int as verified,
      count(*) filter (where p.qualified_at is not null and p.email is not null)::int as qualified,
      count(d.prospect_id)::int as drafted,
      count(se.prospect_id)::int as sent,
      count(*) filter (where se.delivered)::int as delivered,
      count(r.prospect_id)::int as replied,
      count(*) filter (where se.prospect_id is not null and p.interested_at is not null)::int as interested,
      count(*) filter (where se.prospect_id is not null and p.signed_up)::int as signed_up,
      count(*) filter (where se.prospect_id is not null and p.activated)::int as activated,
      count(*) filter (where se.prospect_id is not null and p.paid)::int as paid
    from prospects p
      left join sent se on se.prospect_id = p.id
      left join replied r on r.prospect_id = p.id
      left join drafted d on d.prospect_id = p.id
    where ${prospectScope(s)}`);
}

export interface EmailStats {
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
  replied: number;
  positive: number;
  unsubscribed: number;
  signedUp: number;
  activated: number;
  paid: number;
  rates: { delivery: number | null; bounce: number | null; reply: number | null; positive: number | null; unsubscribe: number | null };
  costs: { currency: string; amount: number }[];
  costPer: { activated: number | null; paid: number | null; signup: number | null; currency: string | null };
  sentToday: number;
  queued: number;
  awaitingReview: number;
}

const rate = (n: number, d: number) => (d > 0 ? n / d : null);

export async function emailStats(q: Q, s: EmailScope = {}): Promise<EmailStats> {
  const r = await q.one<{ sent: number; delivered: number; bounced: number; complained: number; replied: number; positive: number; unsubscribed: number; signed_up: number; activated: number; paid: number; sent_today: number }>(sql`
    with msgs as (
      select m.id, m.prospect_id, m.delivery_status, m.sent_at from outreach_messages m join prospects p on p.id = m.prospect_id
      where ${sentScope(s)} and ${prospectScope(s)}
    ), people as (select distinct prospect_id from msgs)
    select
      (select count(*) from msgs)::int as sent,
      (select count(*) from msgs where delivery_status = 'delivered')::int as delivered,
      (select count(*) from msgs where delivery_status = 'bounced')::int as bounced,
      (select count(*) from msgs where delivery_status = 'complained')::int as complained,
      (select count(distinct e.prospect_id) from email_events e where e.message_id in (select id from msgs) and e.type = 'replied' and coalesce(e.detail, '') not like 'Auto-reply%')::int as replied,
      (select count(*) from conversations c where c.channel = 'email' and c.prospect_id in (select prospect_id from people) and c.intent = any(${`{${POSITIVE.join(",")}}`}::text[]))::int as positive,
      (select count(distinct e.prospect_id) from email_events e where e.type = 'unsubscribed' and e.prospect_id in (select prospect_id from people))::int as unsubscribed,
      (select count(*) from prospects p where p.id in (select prospect_id from people) and p.signed_up)::int as signed_up,
      (select count(*) from prospects p where p.id in (select prospect_id from people) and p.activated)::int as activated,
      (select count(*) from prospects p where p.id in (select prospect_id from people) and p.paid)::int as paid,
      (select count(*) from msgs where sent_at >= date_trunc('day', now()))::int as sent_today`);
  const costs = await q.many<{ currency: string; amount: number }>(sql`
    select currency, sum(amount)::float8 as amount from (
      select currency, amount from costs where ${s.campaignId ? sql`campaign_id = ${s.campaignId}` : sql`true`}
        ${s.from ? sql`and incurred_on >= ${s.from}` : sql``} ${s.to ? sql`and incurred_on < ${s.to}` : sql``}
      union all
      select cost_currency, cost_amount from campaigns where cost_amount is not null and cost_amount > 0 ${s.campaignId ? sql`and id = ${s.campaignId}` : sql``}
    ) x group by currency order by amount desc`);
  const queue = await q.one<{ queued: number; review: number }>(sql`
    select count(*) filter (where status = 'queued')::int as queued, count(*) filter (where status = 'needs_review')::int as review
    from outreach_messages where channel = 'email' and not is_test ${s.campaignId ? sql`and campaign_id = ${s.campaignId}` : sql``}`);
  // Cost-per only when all costs share one currency; never mix currencies.
  const single = costs.length === 1 ? costs[0] : null;
  return {
    sent: r.sent, delivered: r.delivered, bounced: r.bounced, complained: r.complained, replied: r.replied, positive: r.positive,
    unsubscribed: r.unsubscribed, signedUp: r.signed_up, activated: r.activated, paid: r.paid,
    rates: {
      delivery: rate(r.delivered, r.sent), bounce: rate(r.bounced, r.sent), reply: rate(r.replied, r.sent),
      positive: rate(r.positive, r.sent), unsubscribe: rate(r.unsubscribed, r.sent),
    },
    costs,
    costPer: {
      currency: single?.currency ?? null,
      signup: single && r.signed_up ? single.amount / r.signed_up : null,
      activated: single && r.activated ? single.amount / r.activated : null,
      paid: single && r.paid ? single.amount / r.paid : null,
    },
    sentToday: r.sent_today,
    queued: queue.queued,
    awaitingReview: queue.review,
  };
}

export async function emailByCountry(q: Q, s: EmailScope = {}) {
  return q.many<{ country: string; prospects: number; with_email: number; sent: number; replied: number; signed_up: number }>(sql`
    with sent as (select distinct m.prospect_id from outreach_messages m where ${sentScope(s)}),
    replied as (
      select distinct e.prospect_id from email_events e join outreach_messages m on m.id = e.message_id
      where e.type = 'replied' and coalesce(e.detail, '') not like 'Auto-reply%' and ${sentScope(s)}
    )
    select coalesce(p.country, '—') as country, count(*)::int as prospects, count(*) filter (where p.email is not null)::int as with_email,
      count(se.prospect_id)::int as sent, count(r.prospect_id)::int as replied, count(*) filter (where se.prospect_id is not null and p.signed_up)::int as signed_up
    from prospects p left join sent se on se.prospect_id = p.id left join replied r on r.prospect_id = p.id
    where ${prospectScope({ ...s, country: null })}
    group by 1 order by prospects desc limit 30`);
}

export interface SenderUsageRow {
  id: string; email_address: string | null; label: string; provider: string; status: string; paused_reason: string | null;
  sent_today: number; cap: number; daily_cap: number; provider_daily_limit: number | null; min_interval_seconds: number;
  warmup_enabled: boolean; warmup_start_cap: number; warmup_step: number; warmup_started_on: Date;
  sent_30d: number; bounced_30d: number; complained_30d: number; last_error: string | null; last_synced_at: Date | null;
  dns_checks: DnsCheck | null; dns_checked_at: Date | null;
}

export async function senderUsage(q: Q): Promise<SenderUsageRow[]> {
  const rows = await q.many<Omit<SenderUsageRow, "cap">>(sql`
    select a.id, a.email_address, a.label, a.provider, a.status, a.paused_reason, a.daily_cap, a.provider_daily_limit, a.min_interval_seconds,
      a.warmup_enabled, a.warmup_start_cap, a.warmup_step, a.warmup_started_on, a.last_error, a.last_synced_at, a.dns_checks, a.dns_checked_at,
      (select count(*) from outreach_messages m where m.sender_account_id = a.id and m.status = 'sent' and not m.is_test and m.sent_at >= date_trunc('day', now()))::int as sent_today,
      (select count(*) from outreach_messages m where m.sender_account_id = a.id and m.status = 'sent' and not m.is_test and m.sent_at >= now() - interval '30 days')::int as sent_30d,
      (select count(*) from outreach_messages m where m.sender_account_id = a.id and m.delivery_status = 'bounced' and m.sent_at >= now() - interval '30 days')::int as bounced_30d,
      (select count(*) from outreach_messages m where m.sender_account_id = a.id and m.delivery_status = 'complained' and m.sent_at >= now() - interval '30 days')::int as complained_30d
    from sender_accounts a where a.channel = 'email' and a.is_active order by a.created_at`);
  // Today's real cap: warm-up ramp, never above the provider's own limit.
  return rows.map((r) => {
    const cap = effectiveDailyCap(r);
    return { ...r, cap: r.provider_daily_limit ? Math.min(cap, r.provider_daily_limit) : cap };
  });
}
