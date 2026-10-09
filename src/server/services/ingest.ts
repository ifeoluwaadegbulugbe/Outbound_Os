import { sql, raw, join, json, textArray, or, type Q } from "../db";
import type { NormalizedProspect } from "../adapters/types";
import {
  extractSignals, normalizeEmail, normalizeHandle, normalizeName, normalizePhone, normalizeUrl, domainOf,
  type ExtractedSignals,
} from "../domain/normalize";
import { compareProspects, type DedupRecord } from "../domain/dedup";
import { findCity, NIGERIAN_CITIES } from "../domain/taxonomy";
import { rescoreProspect, getIcpConfig } from "./scoring-service";
import { logEvent, type ActorCtx } from "./audit";
import type { IcpConfig } from "../domain/scoring";
import { recordSourceEmail } from "../email/enrich";

export type IngestOutcome = "created" | "merged" | "flagged" | "suppressed" | "skipped";

export interface IngestResult {
  outcome: IngestOutcome;
  prospectId: string | null;
  reason?: string;
  duplicateOf?: { id: string; confidence: number }[];
}

export interface IngestOptions {
  campaignId?: string | null;
  icp?: { id: string | null; config: IcpConfig };
  skipScoring?: boolean;
}

interface Prepared {
  row: Record<string, unknown>;
  signals: Record<string, { value: unknown; source: string; quote?: string }>;
  dedup: DedupRecord;
}

/** Normalize + enrich an adapter record from its own text, citing evidence. */
export function prepare(n: NormalizedProspect): Prepared {
  const text = [n.bio, n.description].filter(Boolean).join("\n");
  const ex: ExtractedSignals = extractSignals(text, n.bio ? "bio" : "description", [n.website, n.booking_url].filter(Boolean) as string[]);
  const extra = n.extra_text ? extractSignals(n.extra_text, "posts") : null;

  const cc = (n.country && n.country.length === 2 ? n.country : "NG").toUpperCase();
  const phone = normalizePhone(n.phone, cc) ?? ex.phones[0]?.value ?? null;
  const whatsapp = normalizePhone(n.whatsapp, cc) ?? (ex.whatsappBookings ? phone : null);
  const ig = normalizeHandle(n.instagram_handle) ?? ex.instagram[0]?.value ?? null;
  const tt = normalizeHandle(n.tiktok_handle) ?? ex.tiktok[0]?.value ?? null;
  const website = normalizeUrl(n.website);
  const booking = normalizeUrl(n.booking_url) ?? ex.bookingUrl?.value ?? null;
  const cityInfo = findCity(n.city ?? "") ?? (n.city ? null : findCity(ex.city?.value ?? ""));
  const city = cityInfo?.name ?? (n.city?.trim() || null);

  const signals: Prepared["signals"] = {};
  const put = (k: string, e: { value: unknown; source: string; quote?: string } | null | undefined) => {
    if (e) signals[k] = { value: e.value, source: e.source, ...(e.quote ? { quote: e.quote } : {}) };
  };
  put("acceptsBookings", ex.acceptsBookings ?? extra?.acceptsBookings);
  put("whatsappBookings", ex.whatsappBookings ?? extra?.whatsappBookings);
  put("dmBookings", ex.dmBookings ?? extra?.dmBookings);
  put("manualPayments", ex.manualPayments ?? extra?.manualPayments);
  put("onlinePayments", ex.onlinePayments ?? extra?.onlinePayments);
  put("schedulingTool", ex.schedulingTool);
  if (ex.category && !n.category) put("category", ex.category);
  if (ex.city && !n.city) put("city", ex.city);
  if (ex.phones[0] && !n.phone) put("phone", ex.phones[0]);
  if (ex.bookingUrl && !n.booking_url) put("bookingUrl", ex.bookingUrl);

  const services = Array.from(new Set([...(n.services ?? []), ...ex.services.map((s) => s.value), ...(extra?.services.map((s) => s.value) ?? [])])).slice(0, 12);

  const row: Record<string, unknown> = {
    business_name: n.business_name.trim().slice(0, 200),
    normalized_name: normalizeName(n.business_name) || n.business_name.toLowerCase(),
    owner_name: n.owner_name?.trim() || null,
    first_name: n.owner_name?.trim().split(/\s+/)[0] || null,
    last_name: n.owner_name?.trim().split(/\s+/).slice(1).join(" ") || null,
    category: n.category ?? ex.category?.value ?? extra?.category?.value ?? null,
    subcategory: n.subcategory ?? null,
    services,
    description: n.description?.slice(0, 2000) ?? null,
    bio: n.bio?.slice(0, 2000) ?? null,
    business_size: n.business_size ?? null,
    country: n.country ?? (cityInfo ? "NG" : null),
    state: n.state ?? cityInfo?.state ?? null,
    city,
    area: n.area ?? null,
    timezone: cityInfo || (n.country ?? "").toUpperCase() === "NG" ? "Africa/Lagos" : null,
    lat: n.lat ?? null,
    lng: n.lng ?? null,
    instagram_handle: ig,
    instagram_url: ig ? `https://www.instagram.com/${ig}/` : null,
    tiktok_handle: tt,
    tiktok_url: tt ? `https://www.tiktok.com/@${tt}` : null,
    facebook_url: normalizeUrl(n.facebook_url),
    linkedin_url: normalizeUrl(n.linkedin_url),
    youtube_url: normalizeUrl(n.youtube_url),
    email: normalizeEmail(n.email) ?? ex.emails[0]?.value ?? null,
    phone,
    whatsapp,
    website,
    website_domain: domainOf(website),
    booking_url: booking,
    has_booking_link: booking ? true : null,
    has_website: website ? true : null,
    accepts_bookings: signals.acceptsBookings ? true : null,
    accepts_whatsapp_bookings: signals.whatsappBookings ? true : null,
    accepts_online_payments: signals.onlinePayments ? true : null,
    has_client_management_system: signals.schedulingTool ? true : null,
    follower_count: n.follower_count ?? null,
    last_post_date: n.last_post_date ? new Date(n.last_post_date) : null,
    posting_frequency: n.posting_frequency ?? null,
    activity_score: null,
    signals,
    source: n.source,
    source_url: normalizeUrl(n.source_url) ?? n.source_url ?? null,
    is_demo: Boolean(n.is_demo),
  };
  const dedup: DedupRecord = {
    business_name: row.business_name as string, city, instagram_handle: ig, tiktok_handle: tt, phone, whatsapp,
    email: row.email as string | null, website_domain: row.website_domain as string | null, owner_name: row.owner_name as string | null,
    source_url: row.source_url as string | null,
  };
  return { row, signals, dedup };
}

const INSERT_COLUMNS = [
  "business_name", "normalized_name", "owner_name", "first_name", "last_name", "category", "subcategory", "services",
  "description", "bio", "business_size", "country", "state", "city", "area", "timezone", "lat", "lng", "instagram_handle",
  "instagram_url", "tiktok_handle", "tiktok_url", "facebook_url", "linkedin_url", "youtube_url", "email", "phone", "whatsapp",
  "website", "website_domain", "booking_url", "has_booking_link", "has_website", "accepts_bookings", "accepts_whatsapp_bookings",
  "accepts_online_payments", "has_client_management_system", "follower_count", "last_post_date", "posting_frequency",
  "activity_score", "signals", "source", "source_url", "is_demo",
] as const;

function valueFrag(col: string, v: unknown) {
  if (col === "services") return textArray((v as string[]) ?? []);
  if (col === "signals") return json(v ?? {});
  return sql`${v}`;
}

async function isSuppressed(q: Q, d: DedupRecord): Promise<string | null> {
  const keys: [string, string | null][] = [
    ["email", d.email], ["phone", d.phone], ["phone", d.whatsapp], ["instagram", d.instagram_handle], ["tiktok", d.tiktok_handle],
    ["domain", d.website_domain],
  ];
  const conds = keys.filter(([, v]) => v).map(([k, v]) => sql`(kind = ${k} and value = ${String(v).toLowerCase()})`);
  if (!conds.length) return null;
  const hit = await q.maybe<{ kind: string; reason: string }>(sql`select kind, reason from dnc_entries where ${or(conds)} limit 1`);
  return hit ? `On do-not-contact list (${hit.kind}, ${hit.reason.replace("_", " ")})` : null;
}

async function findCandidates(q: Q, d: DedupRecord): Promise<(DedupRecord & { id: string })[]> {
  const conds = [
    d.instagram_handle && sql`lower(instagram_handle) = ${d.instagram_handle}`,
    d.tiktok_handle && sql`lower(tiktok_handle) = ${d.tiktok_handle}`,
    d.phone && sql`(phone = ${d.phone} or whatsapp = ${d.phone})`,
    d.whatsapp && sql`(phone = ${d.whatsapp} or whatsapp = ${d.whatsapp})`,
    d.email && sql`lower(email) = ${d.email}`,
    d.website_domain && sql`website_domain = ${d.website_domain}`,
    d.source_url && sql`source_url = ${d.source_url}`,
    sql`similarity(normalized_name, ${normalizeName(d.business_name)}) > 0.45`,
  ];
  return q.many(sql`
    select id, business_name, city, instagram_handle, tiktok_handle, phone, whatsapp, email, website_domain, owner_name, source_url
    from prospects
    where merged_into is null and ${or(conds)}
    limit 25`);
}

/** Fill-only merge: never overwrite known values, except fresher activity data. */
async function mergeInto(q: Q, targetId: string, row: Record<string, unknown>): Promise<void> {
  const sets = INSERT_COLUMNS.filter((c) => !["business_name", "normalized_name", "source", "source_url", "is_demo", "signals", "services", "follower_count", "last_post_date", "posting_frequency"].includes(c)).map(
    (c) => sql`${raw(c)} = coalesce(${raw(c)}, ${valueFrag(c, row[c])})`,
  );
  await q.exec(sql`
    update prospects set
      ${join(sets)},
      services = (select array(select distinct unnest(services || ${textArray((row.services as string[]) ?? [])})) ),
      signals = ${json(row.signals ?? {})} || signals,
      follower_count = coalesce(${row.follower_count as number | null}, follower_count),
      last_post_date = greatest(last_post_date, ${row.last_post_date as Date | null}::timestamptz),
      posting_frequency = coalesce(${row.posting_frequency as number | null}, posting_frequency)
    where id = ${targetId}`);
}

export async function ingestProspect(q: Q, ctx: ActorCtx, n: NormalizedProspect, opts: IngestOptions = {}): Promise<IngestResult> {
  if (!n.business_name?.trim()) return { outcome: "skipped", prospectId: null, reason: "Missing business name" };
  const prep = prepare(n);

  const suppressed = await isSuppressed(q, prep.dedup);
  if (suppressed) return { outcome: "suppressed", prospectId: null, reason: suppressed };

  // Same record from the same source again → refresh it.
  if (n.external_id) {
    const existing = await q.maybe<{ prospect_id: string }>(sql`select prospect_id from prospect_sources where source = ${n.source} and external_id = ${n.external_id}`);
    if (existing) {
      const live = await q.value<string>(sql`select coalesce(merged_into, id) from prospects where id = ${existing.prospect_id}`);
      await mergeInto(q, live, prep.row);
      if (!opts.skipScoring) await rescoreProspect(q, live, opts.icp);
      if (opts.campaignId) await addToCampaign(q, ctx.workspaceId, opts.campaignId, [live]);
      return { outcome: "merged", prospectId: live, reason: "Already discovered from this source" };
    }
  }

  const candidates = await findCandidates(q, prep.dedup);
  const matches = candidates
    .map((c) => ({ c, m: compareProspects(c, prep.dedup) }))
    .filter((x) => x.m.decision !== "distinct")
    .sort((a, b) => b.m.confidence - a.m.confidence);

  const best = matches[0];
  if (best && best.m.decision === "merge") {
    await mergeInto(q, best.c.id, prep.row);
    await addSource(q, ctx.workspaceId, best.c.id, n);
    if (prep.row.email) await recordSourceEmail(q, ctx.workspaceId, best.c.id, prep.row.email as string, n.source, n.source_url ?? null);
    if (!opts.skipScoring) await rescoreProspect(q, best.c.id, opts.icp);
    if (opts.campaignId) await addToCampaign(q, ctx.workspaceId, opts.campaignId, [best.c.id]);
    await logEvent(q, ctx, { type: "prospect.merged", prospectId: best.c.id, data: { source: n.source, reasons: best.m.reasons } });
    return { outcome: "merged", prospectId: best.c.id, reason: best.m.reasons.join("; ") };
  }

  const cols = INSERT_COLUMNS.map((c) => raw(c));
  const vals = INSERT_COLUMNS.map((c) => valueFrag(c, prep.row[c]));
  const id = await q.value<string>(sql`
    insert into prospects (workspace_id, ${join(cols)}, imported_at)
    values (${ctx.workspaceId}, ${join(vals)}, ${n.source === "csv" ? new Date() : null})
    returning id`);
  await addSource(q, ctx.workspaceId, id, n);
  if (prep.row.email) await recordSourceEmail(q, ctx.workspaceId, id, prep.row.email as string, n.source, n.source_url ?? null);

  const flagged = matches.filter((x) => x.m.decision === "flag");
  for (const f of flagged) {
    const [a, b] = [id, f.c.id].sort();
    await q.exec(sql`
      insert into possible_duplicates (workspace_id, prospect_a, prospect_b, confidence, reasons)
      values (${ctx.workspaceId}, ${a}, ${b}, ${f.m.confidence}, ${json({ reasons: f.m.reasons, conflicts: f.m.conflicts })})
      on conflict (prospect_a, prospect_b) do nothing`);
  }
  if (!opts.skipScoring) await rescoreProspect(q, id, opts.icp);
  if (opts.campaignId) await addToCampaign(q, ctx.workspaceId, opts.campaignId, [id]);
  await logEvent(q, ctx, { type: "prospect.discovered", prospectId: id, campaignId: opts.campaignId, data: { source: n.source } });

  return flagged.length
    ? { outcome: "flagged", prospectId: id, duplicateOf: flagged.map((f) => ({ id: f.c.id, confidence: f.m.confidence })) }
    : { outcome: "created", prospectId: id };
}

async function addSource(q: Q, workspaceId: string, prospectId: string, n: NormalizedProspect): Promise<void> {
  await q.exec(sql`
    insert into prospect_sources (workspace_id, prospect_id, source, external_id, source_url, raw)
    values (${workspaceId}, ${prospectId}, ${n.source}, ${n.external_id ?? null}, ${n.source_url ?? null}, ${json(n.raw ?? null)})
    on conflict do nothing`);
  const socials: [string, string | null | undefined, string | null][] = [
    ["instagram", normalizeHandle(n.instagram_handle), n.instagram_handle ? `https://www.instagram.com/${normalizeHandle(n.instagram_handle)}/` : null],
    ["tiktok", normalizeHandle(n.tiktok_handle), n.tiktok_handle ? `https://www.tiktok.com/@${normalizeHandle(n.tiktok_handle)}` : null],
  ];
  for (const [platform, handle, url] of socials) {
    if (!handle) continue;
    await q.exec(sql`
      insert into prospect_social_profiles (workspace_id, prospect_id, platform, handle, url, followers, following, posts, bio, last_post_at, posting_frequency, fetched_at, source)
      values (${workspaceId}, ${prospectId}, ${platform}, ${handle}, ${url},
              ${platform === "instagram" ? (n.follower_count ?? null) : null}, ${platform === "instagram" ? (n.following_count ?? null) : null},
              ${platform === "instagram" ? (n.media_count ?? null) : null}, ${platform === "instagram" ? (n.bio ?? null) : null},
              ${platform === "instagram" && n.last_post_date ? new Date(n.last_post_date) : null},
              ${platform === "instagram" ? (n.posting_frequency ?? null) : null}, now(), ${n.source})
      on conflict (prospect_id, platform, handle) do update set
        followers = coalesce(excluded.followers, prospect_social_profiles.followers),
        bio = coalesce(excluded.bio, prospect_social_profiles.bio),
        last_post_at = greatest(excluded.last_post_at, prospect_social_profiles.last_post_at),
        fetched_at = now()`);
  }
}

export async function addToCampaign(q: Q, workspaceId: string, campaignId: string, prospectIds: string[]): Promise<number> {
  if (!prospectIds.length) return 0;
  const rows = await q.many(sql`
    insert into campaign_prospects (workspace_id, campaign_id, prospect_id)
    select ${workspaceId}, ${campaignId}, unnest(${textArray(prospectIds)}::uuid[])
    on conflict do nothing
    returning prospect_id`);
  return rows.length;
}

/** Ingest a batch, reusing one ICP config lookup. */
export async function ingestMany(q: Q, ctx: ActorCtx, items: NormalizedProspect[], opts: IngestOptions = {}) {
  const icp = opts.icp ?? (await getIcpConfig(q));
  const counts: Record<IngestOutcome, number> = { created: 0, merged: 0, flagged: 0, suppressed: 0, skipped: 0 };
  const results: IngestResult[] = [];
  for (const n of items) {
    const r = await ingestProspect(q, ctx, n, { ...opts, icp });
    counts[r.outcome]++;
    results.push(r);
  }
  return { counts, results };
}

export { NIGERIAN_CITIES };
