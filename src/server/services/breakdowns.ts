import { sql, raw, type Q, type SqlFragment } from "../db";

/** Grouped funnel rates by a whitelisted dimension. Computed in SQL, never estimated. */

export const DIMENSIONS = {
  category: { label: "Category", expr: "p.category" },
  city: { label: "City", expr: "p.city" },
  channel: { label: "First-touch channel", expr: "(select m.channel from outreach_messages m where m.prospect_id = p.id and m.kind = 'initial' and m.status = 'sent' order by m.sent_at limit 1)" },
  angle: { label: "Message angle", expr: "(select m.angle from outreach_messages m where m.prospect_id = p.id and m.kind = 'initial' and m.status = 'sent' order by m.sent_at limit 1)" },
  variant: { label: "Message variant", expr: "(select v.key || ' · ' || v.name from outreach_messages m join message_variants v on v.id = m.variant_id where m.prospect_id = p.id and m.kind = 'initial' and m.status = 'sent' order by m.sent_at limit 1)" },
  source: { label: "Discovery source", expr: "p.source" },
  booking_link: { label: "Booking link", expr: "case when p.booking_url is not null or p.has_booking_link then 'Has booking link' else 'No booking link' end" },
  size: { label: "Business size", expr: "coalesce(p.business_size, 'unknown')" },
} as const;
export type Dimension = keyof typeof DIMENSIONS;

export interface BreakdownRow {
  key: string;
  prospects: number;
  contacted: number;
  replied: number;
  interested: number;
  signed_up: number;
  activated: number;
  paid: number;
}

export async function breakdown(q: Q, dim: Dimension, scope: SqlFragment, opts: { contactedOnly?: boolean; limit?: number } = {}): Promise<BreakdownRow[]> {
  const expr = raw(DIMENSIONS[dim].expr);
  return q.many<BreakdownRow>(sql`
    select coalesce(${expr}, 'Unknown') as key,
      count(*)::int as prospects,
      count(*) filter (where p.first_contacted_at is not null)::int as contacted,
      count(*) filter (where p.replied_at is not null)::int as replied,
      count(*) filter (where p.interested_at is not null)::int as interested,
      count(*) filter (where p.signed_up)::int as signed_up,
      count(*) filter (where p.activated)::int as activated,
      count(*) filter (where p.paid)::int as paid
    from prospects p
    where ${scope} ${opts.contactedOnly ? sql`and p.first_contacted_at is not null` : sql``}
    group by 1
    order by count(*) filter (where p.first_contacted_at is not null) desc, count(*) desc
    limit ${opts.limit ?? 20}`);
}

export async function dailySeries(q: Q, from: Date, to: Date, scope: SqlFragment) {
  return q.many<{ day: string; contacted: number; replied: number; signed_up: number; discovered: number }>(sql`
    with days as (select generate_series(date_trunc('day', ${from}::timestamptz), date_trunc('day', ${to}::timestamptz), interval '1 day') as day)
    select to_char(d.day, 'YYYY-MM-DD') as day,
      (select count(*)::int from prospects p where ${scope} and p.discovered_at >= d.day and p.discovered_at < d.day + interval '1 day') as discovered,
      (select count(*)::int from prospects p where ${scope} and p.first_contacted_at >= d.day and p.first_contacted_at < d.day + interval '1 day') as contacted,
      (select count(*)::int from prospects p where ${scope} and p.replied_at >= d.day and p.replied_at < d.day + interval '1 day') as replied,
      (select count(*)::int from prospects p where ${scope} and p.signup_at >= d.day and p.signup_at < d.day + interval '1 day') as signed_up
    from days d order by d.day`);
}
