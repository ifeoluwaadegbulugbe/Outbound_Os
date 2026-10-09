import { sql, type Q } from "../db";
import { categoryLabel, CHANNEL_LABELS, MESSAGE_ANGLES, type Channel } from "../domain/taxonomy";

/**
 * Insights are statistics computed from the database, phrased as sentences.
 * Rules: every comparison needs MIN_SAMPLE in each group, and the evidence
 * line always shows the raw counts so a human can sanity-check it.
 * No LLM is involved, so nothing can be invented.
 */

export const MIN_SAMPLE = 30;

export interface Insight {
  id: string;
  headline: string;
  evidence: string;
  /** Larger = more interesting; used for ordering. */
  strength: number;
}

interface GroupRate {
  key: string;
  n: number;
  hits: number;
}

function pct(x: number) {
  return `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;
}

function compareGroups(groups: GroupRate[], minHitsTotal = 3): { best: GroupRate; worst: GroupRate; ratio: number } | null {
  const eligible = groups.filter((g) => g.n >= MIN_SAMPLE);
  if (eligible.length < 2) return null;
  if (eligible.reduce((a, g) => a + g.hits, 0) < minHitsTotal) return null;
  const sorted = [...eligible].sort((a, b) => b.hits / b.n - a.hits / a.n);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  const rb = best.hits / best.n;
  const rw = worst.hits / worst.n;
  if (rb === 0) return null;
  return { best, worst, ratio: rw > 0 ? rb / rw : Infinity };
}

export async function computeInsights(q: Q, opts: { limit?: number; campaignId?: string | null } = {}): Promise<Insight[]> {
  const scope = opts.campaignId
    ? sql`and exists (select 1 from campaign_prospects cp where cp.prospect_id = p.id and cp.campaign_id = ${opts.campaignId})`
    : sql``;
  const out: Insight[] = [];

  // 1. Category signup rate
  const cats = await q.many<GroupRate>(sql`
    select p.category as key, count(*)::int as n, count(*) filter (where p.signed_up)::int as hits
    from prospects p where p.first_contacted_at is not null and p.category is not null and p.merged_into is null ${scope}
    group by p.category`);
  const c = compareGroups(cats);
  if (c) {
    const rb = c.best.hits / c.best.n;
    const rw = c.worst.hits / c.worst.n;
    out.push({
      id: "category-signup",
      headline: Number.isFinite(c.ratio)
        ? `${categoryLabel(c.best.key)}s are converting ${c.ratio.toFixed(1)}× better than ${categoryLabel(c.worst.key).toLowerCase()}s.`
        : `${categoryLabel(c.best.key)}s convert to signups; ${categoryLabel(c.worst.key).toLowerCase()}s haven't yet.`,
      evidence: `Signup rate ${pct(rb)} (${c.best.hits}/${c.best.n}) vs ${pct(rw)} (${c.worst.hits}/${c.worst.n}) of contacted.`,
      strength: Math.min(10, Number.isFinite(c.ratio) ? c.ratio : 10),
    });
  }

  // 2. Highest-converting segment (category × city)
  const segs = await q.many<GroupRate>(sql`
    select p.city || '|' || p.category as key, count(*)::int as n, count(*) filter (where p.signed_up)::int as hits
    from prospects p where p.first_contacted_at is not null and p.category is not null and p.city is not null and p.merged_into is null ${scope}
    group by p.city, p.category`);
  const topSeg = segs.filter((s) => s.n >= MIN_SAMPLE && s.hits > 0).sort((a, b) => b.hits / b.n - a.hits / a.n)[0];
  if (topSeg) {
    const [city, cat] = topSeg.key.split("|");
    out.push({
      id: "top-segment",
      headline: `Your highest-converting segment is ${city} ${categoryLabel(cat).toLowerCase()}s.`,
      evidence: `${pct(topSeg.hits / topSeg.n)} signup rate (${topSeg.hits}/${topSeg.n} contacted).`,
      strength: 6,
    });
  }

  // 3. Message angle reply rate (initial messages)
  const angles = await q.many<GroupRate>(sql`
    select m.angle as key, count(*)::int as n,
           count(*) filter (where p.replied_at is not null and p.replied_at > m.sent_at)::int as hits
    from outreach_messages m join prospects p on p.id = m.prospect_id
    where m.status = 'sent' and m.kind = 'initial' and m.angle is not null ${scope}
    group by m.angle`);
  const a = compareGroups(angles);
  if (a) {
    const avg = angles.reduce((s, g) => s + g.hits, 0) / Math.max(1, angles.reduce((s, g) => s + g.n, 0));
    const rb = a.best.hits / a.best.n;
    const lift = avg > 0 ? (rb / avg - 1) * 100 : 0;
    const label = MESSAGE_ANGLES.find((x) => x.key === a.best.key)?.label ?? a.best.key;
    if (lift >= 10) {
      out.push({
        id: "angle-reply",
        headline: `${label} messages get a ${lift.toFixed(0)}% higher reply rate than average.`,
        evidence: `${pct(rb)} reply rate (${a.best.hits}/${a.best.n}) vs ${pct(avg)} overall.`,
        strength: Math.min(8, lift / 10),
      });
    }
  }

  // 4. Booking link vs none
  const bl = await q.many<GroupRate>(sql`
    select case when p.booking_url is not null or p.has_booking_link then 'with' else 'without' end as key,
           count(*)::int as n, count(*) filter (where p.signed_up)::int as hits
    from prospects p where p.first_contacted_at is not null and p.merged_into is null ${scope}
    group by 1`);
  const withL = bl.find((g) => g.key === "with");
  const withoutL = bl.find((g) => g.key === "without");
  if (withL && withoutL && withL.n >= MIN_SAMPLE && withoutL.n >= MIN_SAMPLE && withL.hits + withoutL.hits >= 3) {
    const r1 = withL.hits / withL.n;
    const r0 = withoutL.hits / withoutL.n;
    if (r0 > 0 && r1 > 0 && Math.abs(r1 / r0 - 1) >= 0.2) {
      const better = r1 > r0;
      out.push({
        id: "booking-link",
        headline: better
          ? `Prospects with booking links are converting ${(r1 / r0).toFixed(1)}× better.`
          : `Prospects without booking links are converting ${(r0 / r1).toFixed(1)}× better.`,
        evidence: `${pct(r1)} (${withL.hits}/${withL.n}) with a link vs ${pct(r0)} (${withoutL.hits}/${withoutL.n}) without.`,
        strength: 5,
      });
    }
  }

  // 5. Share of replies that came after a follow-up
  const fu = await q.maybe<{ total: number; after_followup: number }>(sql`
    select count(*)::int as total,
           count(*) filter (where exists (
             select 1 from outreach_messages m where m.prospect_id = p.id and m.kind = 'followup' and m.status = 'sent' and m.sent_at < p.replied_at))::int as after_followup
    from prospects p where p.replied_at is not null and p.merged_into is null ${scope}`);
  if (fu && fu.total >= MIN_SAMPLE && fu.after_followup > 0) {
    out.push({
      id: "followup-share",
      headline: `Your follow-up sequence generates ${pct(fu.after_followup / fu.total)} of all replies.`,
      evidence: `${fu.after_followup} of ${fu.total} replies came after at least one follow-up.`,
      strength: 4,
    });
  }

  // 6. Channel reply rate
  const ch = await q.many<GroupRate>(sql`
    select m.channel as key, count(distinct m.prospect_id)::int as n,
           count(distinct m.prospect_id) filter (where p.replied_at is not null and p.replied_at > m.sent_at)::int as hits
    from outreach_messages m join prospects p on p.id = m.prospect_id
    where m.status = 'sent' and m.kind = 'initial' ${scope}
    group by m.channel`);
  const chc = compareGroups(ch);
  if (chc && Number.isFinite(chc.ratio) && chc.ratio >= 1.2) {
    out.push({
      id: "channel-reply",
      headline: `${CHANNEL_LABELS[chc.best.key as Channel] ?? chc.best.key} gets ${chc.ratio.toFixed(1)}× the reply rate of ${CHANNEL_LABELS[chc.worst.key as Channel] ?? chc.worst.key}.`,
      evidence: `${pct(chc.best.hits / chc.best.n)} (${chc.best.hits}/${chc.best.n}) vs ${pct(chc.worst.hits / chc.worst.n)} (${chc.worst.hits}/${chc.worst.n}).`,
      strength: Math.min(7, chc.ratio),
    });
  }

  return out.sort((x, y) => y.strength - x.strength).slice(0, opts.limit ?? 10);
}
