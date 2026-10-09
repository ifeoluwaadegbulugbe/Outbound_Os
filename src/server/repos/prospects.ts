import { sql, raw, and, textArray, type Q, type SqlFragment } from "../db";
import { compileFilter } from "../domain/filters-sql";
import { filterSchema, type FilterNode } from "../domain/filters";
import { FUNNEL_STAGES } from "../domain/funnel";
import { encodeJson, decodeJson } from "@/lib/filter-codec";

export interface ProspectListParams {
  q?: string;
  status?: string;
  category?: string;
  city?: string;
  campaign?: string;
  stage?: string;
  minIcp?: number;
  source?: string;
  /** found | none | needs_email | sendable | verified | unknown | catch_all | risky | invalid | unverified */
  email?: string;
  country?: string;
  filter?: FilterNode | null;
  sort?: string;
  dir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
  includeDnc?: boolean;
}

export interface ProspectRow {
  id: string;
  business_name: string;
  owner_name: string | null;
  category: string | null;
  city: string | null;
  area: string | null;
  instagram_handle: string | null;
  tiktok_handle: string | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  email_status: string;
  email_source: string | null;
  country: string | null;
  website: string | null;
  website_checked_at: Date | null;
  booking_url: string | null;
  follower_count: number | null;
  icp_score: number | null;
  priority_score: number | null;
  completeness_score: number | null;
  outreach_priority: string | null;
  status: string;
  source: string;
  is_demo: boolean;
  do_not_contact: boolean;
  last_contacted_at: Date | null;
  last_post_date: Date | null;
  discovered_at: Date;
  next_follow_up_at: Date | null;
}

export const SORTS: Record<string, string> = {
  priority: "p.priority_score",
  icp: "p.icp_score",
  name: "lower(p.business_name)",
  followers: "p.follower_count",
  completeness: "p.completeness_score",
  discovered: "p.discovered_at",
  contacted: "p.last_contacted_at",
  status: "p.status",
  city: "lower(p.city)",
  email: "p.email_status",
};

/** Decode the `f` URL param (base64url JSON filter tree). Invalid → null. */
export function decodeFilter(f: string | undefined | null): FilterNode | null {
  if (!f) return null;
  try {
    const json = decodeJson(f);
    const parsed = filterSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function prospectWhere(p: ProspectListParams): SqlFragment {
  const term = p.q?.trim();
  const stage = FUNNEL_STAGES.find((s) => s.key === p.stage);
  return and([
    sql`p.merged_into is null`,
    sql`p.archived_at is null`,
    term
      ? sql`(p.business_name ilike ${"%" + term.replace(/[%_\\]/g, "\\$&") + "%"} or lower(p.instagram_handle) like ${term.replace(/^@/, "").toLowerCase() + "%"}
             or lower(p.tiktok_handle) like ${term.replace(/^@/, "").toLowerCase() + "%"} or p.bio ilike ${"%" + term.replace(/[%_\\]/g, "\\$&") + "%"})`
      : null,
    p.status ? sql`p.status = any(${textArray(p.status.split(","))})` : null,
    p.category ? sql`p.category = any(${textArray(p.category.split(","))})` : null,
    p.city ? sql`lower(p.city) = any(${textArray(p.city.toLowerCase().split(","))})` : null,
    p.source ? sql`p.source = ${p.source}` : null,
    p.country ? sql`p.country = ${p.country.toUpperCase()}` : null,
    emailWhere(p.email),
    p.campaign ? sql`exists (select 1 from campaign_prospects cp where cp.prospect_id = p.id and cp.campaign_id = ${p.campaign})` : null,
    stage ? raw(stage.where) : null,
    p.minIcp != null && !Number.isNaN(p.minIcp) ? sql`p.icp_score >= ${p.minIcp}` : null,
    p.filter ? compileFilter(p.filter) : null,
  ]);
}

const EMAIL_STATUSES = ["verified", "unknown", "catch_all", "risky", "invalid", "unverified"];

function emailWhere(e: string | undefined): SqlFragment | null {
  if (!e) return null;
  if (e === "found") return sql`p.email is not null`;
  if (e === "none") return sql`p.email is null`;
  if (e === "needs_email") return sql`p.email is null and p.website is not null and p.website_checked_at is null`;
  // Safe to email by default policy: has an address that isn't invalid/risky and isn't suppressed.
  if (e === "sendable") return sql`p.email is not null and p.email_status in ('verified', 'unknown', 'catch_all', 'unverified') and not p.do_not_contact and not p.bounced and not p.unsubscribed`;
  if (EMAIL_STATUSES.includes(e)) return sql`p.email_status = ${e}`;
  return null;
}

export async function listProspects(q: Q, p: ProspectListParams): Promise<{ rows: ProspectRow[]; total: number }> {
  const where = prospectWhere(p);
  const sortCol = SORTS[p.sort ?? "priority"] ?? SORTS.priority;
  const dir = p.dir === "asc" ? "asc" : "desc";
  const pageSize = Math.min(200, Math.max(10, p.pageSize ?? 50));
  const page = Math.max(1, p.page ?? 1);
  const [rows, total] = await Promise.all([
    q.many<ProspectRow>(sql`
      select p.id, p.business_name, p.owner_name, p.category, p.city, p.area, p.instagram_handle, p.tiktok_handle, p.phone, p.whatsapp, p.email,
             p.email_status, p.email_source, p.country, p.website, p.website_checked_at,
             p.booking_url, p.follower_count, p.icp_score, p.priority_score, p.completeness_score, p.outreach_priority, p.status, p.source, p.is_demo,
             p.do_not_contact, p.last_contacted_at, p.last_post_date, p.discovered_at, p.next_follow_up_at
      from prospects p
      where ${where}
      order by ${raw(sortCol)} ${raw(dir)} nulls last, p.id
      limit ${pageSize} offset ${(page - 1) * pageSize}`),
    q.value<number>(sql`select count(*)::int from prospects p where ${where}`),
  ]);
  return { rows, total };
}

/** All ids matching a filter (for "select all N matching" bulk actions), capped. */
export async function matchingIds(q: Q, p: ProspectListParams, cap = 5000): Promise<string[]> {
  const rows = await q.many<{ id: string }>(sql`select p.id from prospects p where ${prospectWhere(p)} order by p.priority_score desc nulls last limit ${cap}`);
  return rows.map((r) => r.id);
}

export function parseListParams(sp: Record<string, string | string[] | undefined>): ProspectListParams {
  const s = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  return {
    q: s("q"),
    status: s("status"),
    category: s("category"),
    city: s("city"),
    campaign: s("campaign"),
    stage: s("stage"),
    source: s("source"),
    email: s("email"),
    country: s("country"),
    minIcp: s("min_icp") ? Number(s("min_icp")) : undefined,
    filter: decodeFilter(s("f")),
    sort: s("sort") ?? "priority",
    dir: s("dir") === "asc" ? "asc" : "desc",
    page: s("page") ? Number(s("page")) : 1,
  };
}

/** Built-in saved views (users can save their own on top). */
export const DEFAULT_VIEWS: { key: string; name: string; params: Record<string, string> }[] = [
  { key: "all", name: "All prospects", params: {} },
  { key: "email-ready", name: "Email ready, not contacted", params: { email: "sendable", f: encodeFilter({ op: "and", children: [{ field: "contacted", cmp: "is_false" }] }), sort: "priority" } },
  { key: "needs-email", name: "Website, email not checked", params: { email: "needs_email" } },
  { key: "verified", name: "Verified emails", params: { email: "verified" } },
  { key: "priority", name: "Top priority, not contacted", params: { f: encodeFilter({ op: "and", children: [{ field: "contacted", cmp: "is_false" }, { field: "do_not_contact", cmp: "is_false" }, { field: "priority_score", cmp: "gte", value: 60 }] }) } },
  { key: "lagos-high", name: "High-value Lagos prospects", params: { city: "Lagos", min_icp: "80" } },
  { key: "followup", name: "Needs follow-up", params: { status: "FOLLOW_UP,CONTACTED" , sort: "contacted", dir: "asc" } },
  { key: "beauty", name: "Beauty businesses", params: { category: "hair_stylist,barber,nail_technician,lash_technician,makeup_artist,skincare" } },
  { key: "signed", name: "Signed up", params: { stage: "signed_up" } },
  { key: "paid-potential", name: "Potential paid customers", params: { status: "ACTIVATED" } },
];

export function encodeFilter(f: FilterNode): string {
  return encodeJson(f);
}
