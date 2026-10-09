import { sql, raw, type Q, type SqlFragment } from "../db";

/**
 * Experiment results. Each variant's cohort is derived from its config
 * (category / first-touch channel / message angle), or from explicit
 * assignments when present, counting prospects first contacted after the
 * experiment started. Significance: two-proportion z-test on the primary metric.
 */

export const METRIC_FIELDS = {
  reply_rate: { label: "Reply rate", num: "p.replied_at is not null" },
  interest_rate: { label: "Interest rate", num: "p.interested_at is not null" },
  signup_rate: { label: "Signup rate", num: "p.signed_up" },
  activation_rate: { label: "Activation rate", num: "p.activated" },
  paid_rate: { label: "Paid rate", num: "p.paid" },
} as const;
export type PrimaryMetric = keyof typeof METRIC_FIELDS;

export interface VariantResult {
  id: string;
  key: string;
  name: string;
  config: Record<string, string>;
  contacted: number;
  replied: number;
  interested: number;
  signed_up: number;
  activated: number;
  paid: number;
}

export interface ExperimentRow {
  id: string;
  name: string;
  hypothesis: string | null;
  kind: "icp" | "message" | "channel" | "offer";
  primary_metric: PrimaryMetric;
  status: string;
  started_at: Date | null;
  ended_at: Date | null;
  campaign_id: string | null;
}

function cohortFor(kind: ExperimentRow["kind"], cfg: Record<string, string>, variantId: string): SqlFragment {
  const firstMsg = (col: string) => sql`(select ${raw(`m.${col}`)} from outreach_messages m where m.prospect_id = p.id and m.kind = 'initial' and m.status = 'sent' order by m.sent_at limit 1)`;
  const assigned = sql`exists (select 1 from experiment_assignments a where a.prospect_id = p.id and a.variant_id = ${variantId})`;
  if (kind === "icp" && cfg.category) return sql`(p.category = ${cfg.category} or ${assigned})`;
  if (kind === "channel" && cfg.channel) return sql`(${firstMsg("channel")} = ${cfg.channel} or ${assigned})`;
  if (kind === "message" && cfg.angle) return sql`(${firstMsg("angle")} = ${cfg.angle} or ${assigned})`;
  if (kind === "message" && cfg.variantId) return sql`(${firstMsg("variant_id")}::text = ${cfg.variantId} or ${assigned})`;
  return assigned;
}

export async function experimentResults(q: Q, e: ExperimentRow): Promise<VariantResult[]> {
  const variants = await q.many<{ id: string; key: string; name: string; config: Record<string, string> }>(sql`select id, key, name, config from experiment_variants where experiment_id = ${e.id} order by key`);
  const out: VariantResult[] = [];
  for (const v of variants) {
    const r = await q.one<Omit<VariantResult, "id" | "key" | "name" | "config">>(sql`
      select count(*)::int as contacted,
        count(*) filter (where p.replied_at is not null)::int as replied,
        count(*) filter (where p.interested_at is not null)::int as interested,
        count(*) filter (where p.signed_up)::int as signed_up,
        count(*) filter (where p.activated)::int as activated,
        count(*) filter (where p.paid)::int as paid
      from prospects p
      where p.merged_into is null and p.first_contacted_at is not null
        ${e.started_at ? sql`and p.first_contacted_at >= ${e.started_at}` : sql``}
        ${e.ended_at ? sql`and p.first_contacted_at < ${e.ended_at}` : sql``}
        ${e.campaign_id ? sql`and exists (select 1 from campaign_prospects cp where cp.prospect_id = p.id and cp.campaign_id = ${e.campaign_id})` : sql``}
        and ${cohortFor(e.kind, v.config, v.id)}`);
    out.push({ ...v, ...r });
  }
  return out;
}

export function metricCount(v: VariantResult, m: PrimaryMetric): number {
  return { reply_rate: v.replied, interest_rate: v.interested, signup_rate: v.signed_up, activation_rate: v.activated, paid_rate: v.paid }[m];
}

function normalCdf(z: number): number {
  // Abramowitz–Stegun approximation
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

export interface Verdict {
  status: "insufficient" | "no_difference" | "leading";
  leader?: string;
  lift?: number;      // percentage points
  pValue?: number;
  message: string;
}

export function verdict(results: VariantResult[], m: PrimaryMetric, minSample = 30): Verdict {
  if (results.length < 2) return { status: "insufficient", message: "Add at least two variants." };
  const thin = results.filter((r) => r.contacted < minSample);
  if (thin.length) return { status: "insufficient", message: `Needs ${minSample}+ contacted per variant (${thin.map((t) => `${t.key}: ${t.contacted}`).join(", ")}).` };
  const sorted = [...results].sort((a, b) => metricCount(b, m) / b.contacted - metricCount(a, m) / a.contacted);
  const [a, b] = sorted;
  const pa = metricCount(a, m) / a.contacted;
  const pb = metricCount(b, m) / b.contacted;
  const pool = (metricCount(a, m) + metricCount(b, m)) / (a.contacted + b.contacted);
  const se = Math.sqrt(pool * (1 - pool) * (1 / a.contacted + 1 / b.contacted));
  if (se === 0) return { status: "no_difference", message: "No difference yet." };
  const z = (pa - pb) / se;
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  const lift = (pa - pb) * 100;
  if (p < 0.05) return { status: "leading", leader: a.key, lift, pValue: p, message: `${a.key} (${a.name}) is ahead by ${lift.toFixed(1)} pts — statistically significant (p = ${p.toFixed(3)}).` };
  return { status: "no_difference", leader: a.key, lift, pValue: p, message: `${a.key} leads by ${lift.toFixed(1)} pts, but it's not significant yet (p = ${p.toFixed(2)}). Keep running.` };
}
